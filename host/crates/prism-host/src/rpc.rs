//! One WebSocket = one client session: `host.hello` first, then requests
//! (`host.*` here, everything else routed to its domain on its own task) and
//! notifications pushed by the domains.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use prism_protocol::{
    methods, ErrorCode, HelloParams, HelloResult, HostError, OkResult, PingResult, ProtocolVersion, Role, RpcRequest,
    RpcResponse, UserInfo, JSONRPC,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::domain::{next_client_id, CallContext, Notifier};
use crate::server::tokens_match;
use crate::HostState;

/// The client must say hello this fast after connecting.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// What a session knows about its caller after the handshake.
#[derive(Debug, Clone)]
pub struct Session {
    pub user: UserInfo,
    pub notifier: Notifier,
}

pub async fn serve(socket: WebSocket, state: Arc<HostState>) {
    let (mut sink, mut stream) = socket.split();
    let user = match tokio::time::timeout(HELLO_TIMEOUT, handshake(&mut stream, &state)).await {
        Ok(Ok((id, user))) => {
            let result = HelloResult {
                host_id: state.host_id.clone(),
                host_name: state.host_name.clone(),
                version: state.version.clone(),
                protocol: ProtocolVersion::CURRENT,
                capabilities: state.capabilities.clone(),
                user: user.clone(),
            };
            let reply = RpcResponse::ok(id, serde_json::to_value(result).expect("hello result serializes"));
            if send(&mut sink, &reply).await.is_err() {
                return;
            }
            user
        }
        Ok(Err((id, err))) => {
            tracing::info!(code = ?err.code, "handshake recusado");
            let _ = send(&mut sink, &RpcResponse::err(id, &err)).await;
            let _ = sink.send(Message::Close(Some(CloseFrame { code: 4001, reason: "handshake".into() }))).await;
            return;
        }
        Err(_) => {
            let _ = sink.send(Message::Close(Some(CloseFrame { code: 4000, reason: "hello timeout".into() }))).await;
            return;
        }
    };

    let _client = state.activity.client();
    let client = next_client_id();
    // Replies of domain calls and notifications share one outbound queue.
    let (outbound, mut queued) = mpsc::unbounded_channel::<String>();
    let session = Session { user, notifier: Notifier::new(client, outbound.clone()) };
    let mut stopping = state.shutdown.subscribe();
    tracing::info!(user = %session.user.name, client, "cliente conectado");

    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Some(reply) = dispatch(&state, &session, &outbound, &text)
                        && sink.send(Message::Text(reply.into())).await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    let err = HostError::new(ErrorCode::Invalid, "Mensagens binárias não são aceitas.");
                    if send(&mut sink, &RpcResponse::err(Value::Null, &err)).await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            Some(out) = queued.recv() => {
                if sink.send(Message::Text(out.into())).await.is_err() { break; }
            }
            _ = stopping.changed() => {
                let _ = sink.send(Message::Close(Some(CloseFrame { code: 1001, reason: "host encerrando".into() }))).await;
                break;
            }
        }
    }
    for domain in &state.domains {
        domain.disconnected(client);
    }
    tracing::info!(user = %session.user.name, client, "cliente desconectado");
}

/// Reads the first message and validates it as `host.hello`.
async fn handshake(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
    state: &HostState,
) -> Result<(Value, UserInfo), (Value, HostError)> {
    let text = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => break text,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return Err((Value::Null, HostError::new(ErrorCode::Invalid, "Conexão encerrada antes do handshake."))),
        }
    };
    let request: RpcRequest = serde_json::from_str(&text)
        .map_err(|_| (Value::Null, HostError::new(ErrorCode::Invalid, "Mensagem inválida.")))?;
    let id = request.id.clone().unwrap_or(Value::Null);
    if request.jsonrpc != JSONRPC || request.method != methods::HELLO || request.id.is_none() {
        return Err((id, HostError::new(ErrorCode::Invalid, "A primeira mensagem precisa ser host.hello.")));
    }
    let hello: HelloParams = serde_json::from_value(request.params.unwrap_or(Value::Null))
        .map_err(|_| (id.clone(), HostError::new(ErrorCode::Invalid, "Parâmetros de host.hello inválidos.")))?;
    if !ProtocolVersion::CURRENT.compatible_with(&hello.protocol) {
        let message = format!(
            "Versão do protocolo incompatível: o Prism fala {}.{} e este host fala {}.{}. Atualize o Prism ou o host.",
            hello.protocol.major, hello.protocol.minor, ProtocolVersion::CURRENT.major, ProtocolVersion::CURRENT.minor
        );
        return Err((id, HostError::new(ErrorCode::VersionMismatch, message)));
    }
    if !tokens_match(&hello.token, &state.token) {
        return Err((id, HostError::new(ErrorCode::Unauthorized, "Token inválido.")));
    }
    // T01 knows one identity: whoever holds the local token is the owner.
    // Per-person member tokens arrive with T11.
    Ok((id, UserInfo { id: "owner".into(), name: state.owner_name.clone(), role: Role::Owner }))
}

/// Handles one message. `host.*` answers inline; a domain call runs on its
/// own task and answers through `outbound`. Notifications (no `id`) get no
/// reply.
fn dispatch(state: &Arc<HostState>, session: &Session, outbound: &mpsc::UnboundedSender<String>, text: &str) -> Option<String> {
    let request: RpcRequest = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(_) => return reply(Value::Null, Err(HostError::new(ErrorCode::Invalid, "Mensagem inválida."))),
    };
    let id = request.id.clone();
    if request.jsonrpc != JSONRPC {
        return reply(id.unwrap_or(Value::Null), Err(HostError::new(ErrorCode::Invalid, "jsonrpc precisa ser \"2.0\".")));
    }
    let method = request.method.as_str();
    let result = match method {
        methods::PING => Ok(json!(PingResult { pong: true, at: crate::now_ms() })),
        methods::SHUTDOWN => shutdown(state, session),
        methods::HELLO => Err(HostError::new(ErrorCode::Invalid, "O handshake já foi feito nesta conexão.")),
        _ => {
            let Some(domain) = state.domain_for(method) else { return id.and_then(|id| reply(id, Err(unknown(method)))) };
            let verb = &method[domain.name().len() + 1..];
            let ctx = CallContext { user: session.user.clone(), notifier: session.notifier.clone(), state: Arc::clone(state) };
            let Some(call) = domain.call(verb, request.params.unwrap_or(Value::Null), ctx) else {
                return id.and_then(|id| reply(id, Err(unknown(method))));
            };
            let outbound = outbound.clone();
            tokio::spawn(async move {
                let result = call.await;
                if let Some(text) = id.and_then(|id| reply(id, result)) {
                    let _ = outbound.send(text);
                }
            });
            return None;
        }
    };
    id.and_then(|id| reply(id, result))
}

fn unknown(method: &str) -> HostError {
    HostError::new(ErrorCode::MethodNotFound, format!("Método desconhecido: {method}"))
}

fn shutdown(state: &Arc<HostState>, session: &Session) -> Result<Value, HostError> {
    if session.user.role != Role::Owner {
        return Err(HostError::new(ErrorCode::Forbidden, "Só o dono pode encerrar o host."));
    }
    // Reply first; stop right after so the answer reaches the caller.
    let shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        shutdown.trigger("pedido do dono");
    });
    Ok(json!(OkResult { ok: true }))
}

fn reply(id: Value, result: Result<Value, HostError>) -> Option<String> {
    let response = match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(err) => RpcResponse::err(id, &err),
    };
    serde_json::to_string(&response).ok()
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    response: &RpcResponse,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(response).expect("responses serialize");
    sink.send(Message::Text(text.into())).await
}
