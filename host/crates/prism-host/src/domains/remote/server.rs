//! The phone's server: a listener of its own on the loopback (never the
//! host's RPC port), the only thing the tunnel exposes. It serves the mobile
//! page, `/health` and, on `/?t=<token>`, the socket of that token's chat.
//! Port of the server in src/main/ipc/remoteControl.ts.

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};

use axum::extract::ws::{rejection::WebSocketUpgradeRejection, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

use super::{Msg, Outbound};

/// The page the phone opens (a copy of `mobilePage()` in
/// src/main/ipc/remoteControlPage.ts; tests/remote-control-page.test.cjs
/// keeps them equal).
const PAGE: &str = include_str!("page.html");

/// What one phone may send at once (a typed message, a command).
const MAX_MESSAGE_BYTES: usize = 256 * 1024;

/// A phone that says nothing this long is gone (the page pings every 25 s).
const PHONE_IDLE: std::time::Duration = std::time::Duration::from_secs(70);

type Actor = mpsc::UnboundedSender<Msg>;

/// The server while it runs; dropping it stops it.
pub(super) struct Running {
    pub port: u16,
    stop: Option<oneshot::Sender<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

/// Binds a free loopback port and serves on it.
pub(super) async fn start(actor: Actor) -> io::Result<Running> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let port = listener.local_addr()?.port();
    let (stop, stopped) = oneshot::channel::<()>();
    let app = Router::new()
        .route("/", get(root))
        .route("/index.html", get(page))
        .route("/health", get(health))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(actor);
    tokio::spawn(async move {
        let shutdown = async {
            let _ = stopped.await;
        };
        if let Err(err) = axum::serve(listener, app).with_graceful_shutdown(shutdown).await {
            tracing::warn!(%err, "o servidor do controle remoto parou");
        }
    });
    Ok(Running { port, stop: Some(stop) })
}

async fn page() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], PAGE).into_response()
}

async fn health() -> Response {
    ([(header::CONTENT_TYPE, "text/plain")], "ok").into_response()
}

/// The page, or the socket of the chat whose token comes in `t`.
async fn root(State(actor): State<Actor>, Query(query): Query<HashMap<String, String>>, ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>) -> Response {
    let Ok(ws) = ws else { return page().await };
    let token = query.get("t").cloned().unwrap_or_default();
    let (reply, answer) = oneshot::channel();
    if token.is_empty() || actor.send(Msg::PhoneCheck { token: token.clone(), reply }).is_err() || answer.await != Ok(true) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| serve_phone(socket, token, actor))
}

/// One phone, counted only once its socket is up: what it sends goes to the
/// actor, what the actor queues goes out. A phone silent for `PHONE_IDLE`
/// (the page pings every 25 s) is gone.
async fn serve_phone(socket: WebSocket, token: String, actor: Actor) {
    let (tx, mut outbox) = mpsc::channel(super::PHONE_QUEUE);
    let (reply, answer) = oneshot::channel();
    let (mut sink, mut stream) = socket.split();
    let phone = match actor.send(Msg::PhoneOpen { token, tx, reply }).ok().map(|()| answer) {
        Some(answer) => match answer.await {
            Ok(Some(phone)) => phone,
            // Revoked between the check and the upgrade.
            _ => {
                let _ = sink.send(Message::Close(None)).await;
                return;
            }
        },
        None => return,
    };
    let idle = tokio::time::sleep(PHONE_IDLE);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    idle.as_mut().reset(tokio::time::Instant::now() + PHONE_IDLE);
                    if actor.send(Msg::PhoneText { phone, text: text.to_string() }).is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => idle.as_mut().reset(tokio::time::Instant::now() + PHONE_IDLE),
            },
            () = &mut idle => break,
            outgoing = outbox.recv() => match outgoing {
                Some(Outbound::Text(text)) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Some(Outbound::Close) | None => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            },
        }
    }
    let _ = actor.send(Msg::PhoneClosed(phone));
}
