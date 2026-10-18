# Contribuir com o Prism IDE

Você pode ajudar com correções, testes, documentação e relatos reproduzíveis. Procure uma issue existente antes de abrir outra. Para mudanças maiores, descreva primeiro o problema e o comportamento proposto em uma issue.

## Preparar o ambiente

O desenvolvimento e o instalador são validados em **Windows**. Ainda não há validação de distribuição para macOS ou Linux.

Use Git, **Node.js 24** com npm e Rust/Cargo com suporte à edição 2024. Para compilar o host no Windows, instale o toolchain Rust MSVC e o Visual Studio Build Tools com as ferramentas de C++ e o Windows SDK.

Na raiz de uma cópia do repositório:

```powershell
npm ci
npm run host:build
npm run dev
```

O host é um processo Rust separado. A interface usa Electron, React e TypeScript. Testes locais usam também `node:sqlite`, por isso o ambiente de contribuição acima usa Node 24.

As contas dos provedores só são necessárias para testar uma integração real. Use um projeto descartável e considere os limites e custos da sua conta antes de enviar mensagens a um agente. Não configure execuções reais nos testes automatizados.

## Onde alterar

| Área | Local |
| --- | --- |
| Janela Electron e integrações locais | `src/main/` |
| Ponte entre a interface e os processos | `src/preload/` |
| Interface e estado do desktop | `src/renderer/src/` |
| Tipos e lógica compartilhada | `src/shared/` |
| Host, protocolo e execução dos provedores | `host/crates/` |
| Página do controle remoto | `src/renderer/src/remote/` |
| Testes Node e verificações visuais | `tests/` e `scripts/` |

Edite os arquivos de origem da página móvel. `npm run remote:build` gera `src/main/ipc/remoteControlPage.ts` e `host/crates/prism-host/src/domains/remote/page.html`; mantenha os dois atualizados juntos e regenere antes de compilar o host. Ao mudar tipos exportados do protocolo Rust, rode `npm run host:types` e inclua as alterações de `src/shared/host/generated/`.

## Verificar a mudança

Rode os testes relacionados à correção. Para verificar os tipos e a suíte Node:

```powershell
npm run typecheck
node --test --test-concurrency=4 tests/*.test.cjs
```

Alguns testes Node compilam ou executam o host; a primeira execução pode demorar. Os testes de integração com CLIs simuladas criam perfis temporários próprios. Preserve esse isolamento ao adicionar casos.

Para mudanças no host e para conferir o build da aplicação:

```powershell
npm run host:test
npm run build
```

`host:test` executa testes Rust e Clippy. As compilações Rust podem ocupar bastante espaço em `host/target/`.

Para mudanças visuais, após o build, execute a cena relacionada em `scripts/traycer-ui-shots.cjs` ou o teste `node scripts/remote-ui-smoke.cjs`. Confira os screenshots gerados em `out/qa/`. Use somente fixtures fictícios; não habilite opções de QA que enviem mensagens reais para conferir a aparência.

O comando `npm run dist:win` gera o instalador Windows em `dist-app/`. Não é necessário gerar um instalador para toda alteração de documentação ou lógica isolada.

## Enviar um pull request

Crie uma branch no seu fork e mantenha cada PR focado em um problema. Descreva o comportamento anterior, o resultado da mudança e os comandos de validação executados. Se algum teste não foi executado, informe qual e por quê.

Inclua um teste de regressão quando a mudança corrigir um comportamento que possa ser reproduzido automaticamente. Em alterações visuais, anexe uma imagem feita com dados fictícios. Não inclua dependências instaladas, instaladores, caches, `host/target/`, arquivos de `out/qa/` ou dados pessoais no PR.

Não publique tokens, chaves de API, cookies, logins das CLIs, arquivos `.env`, bancos de conversas ou pastas de perfis. URLs e QR codes de controle remoto também concedem acesso: remova-os de screenshots e logs. Revise nomes de usuário, caminhos locais, prompts, código privado e endereços antes de anexar qualquer diagnóstico. Se um segredo já foi exposto, revogue-o no serviço correspondente.

As contribuições ao código do projeto seguem a licença MIT do repositório. Preserve os avisos de licença de dependências e materiais de terceiros.
