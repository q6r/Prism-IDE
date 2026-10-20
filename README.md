<div align="center">

<img src="resources/logo.png" width="84" alt="Prism IDE" />

# Prism IDE

Claude Code e Codex na mesma conversa, com várias contas e um host local em Rust.

[![CI](https://github.com/q6r/Prism-IDE/actions/workflows/ci.yml/badge.svg)](https://github.com/q6r/Prism-IDE/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Prism é uma aplicação desktop independente feita com Electron, React, TypeScript e Monaco. O desenvolvimento e o instalador são validados em **Windows**. Os provedores exigem suas próprias contas e autenticação; o projeto não fornece assinaturas, credenciais ou acesso a modelos.

## Recursos

- **Conversas e projetos:** Claude Code e Codex no mesmo histórico, contas isoladas por perfil, rascunhos por chat, importação local do Traycer e várias tarefas em paralelo.
- **Execução dos agentes:** aprovações, perguntas interativas, anexos com referências `#image 1`, fila compartilhada de mensagens e acompanhamento de subagentes vinculados à conversa principal.
- **Host local em Rust:** mantém as execuções e o histórico em SQLite, separado da janela Electron. Cada subagente pode ser acompanhado pela árvore e por seus cartões de tarefa, atividade e resultado.
- **Mensagens para subagentes:** no Codex, o envio usa a conversa nativa do filho. No Claude, a instrução é encaminhada pelo principal com `SendMessage`, quando o filho possui um endereço nativo disponível. O recebimento no filho aparece quando a CLI o confirma.
- **Imagens do agente:** prévias locais usam a pasta da conversa; imagens podem ser ampliadas, e arquivos ausentes exibem um erro legível.
- **Históricos grandes:** a lista carrega primeiro e cada histórico abre ao selecionar a conversa. Saídas extensas de ferramentas usam prévias com acesso ao conteúdo completo, e imagens de ferramentas carregam conforme aparecem na tela. O host compacta eventos redundantes preservando o histórico e a origem dos dados de uso.
- **Editor e ferramentas:** Monaco, abas, busca global, Quick Open, terminal PTY, Git com diffs e conexão SSH.
- **Controle remoto no celular:** QR por conversa ou seleção de chats, imagens, configurações do agente, aprovações, fila e acompanhamento das alterações. Um link compartilhado concede acesso às conversas selecionadas.
- **Uso e interface:** limites informados pelos provedores, métricas nativas quando disponíveis, temas, atalhos e extensão opcional de Discord Rich Presence.

Os dados de conversas e as contas ficam na máquina do usuário. O controle remoto usa um túnel quando ativado; mantenha seus links e QR codes privados. A autenticação e a execução dos modelos seguem as condições dos respectivos provedores.

## Executar a partir do código

Use **Node.js 24**, npm, Git e Rust stable. No Windows, o Rust precisa do toolchain MSVC, das ferramentas C++ do Visual Studio Build Tools e do Windows SDK.

```powershell
git clone https://github.com/q6r/Prism-IDE.git
cd Prism-IDE
npm ci
npm run remote:build
npm run host:build
npm run dev
```

`remote:build` gera a página móvel que o host incorpora. Execute-o antes de compilar o host quando alterar a interface remota. A primeira compilação Rust pode levar alguns minutos. Os resultados locais ficam em `out/`, `dist-app/` e `host/target/`, fora do Git.

Para usar os agentes, instale as CLIs oficiais conforme as instruções de [Claude Code](https://code.claude.com/docs/en/setup) e [Codex](https://github.com/openai/codex). Em **Conversas → Contas de agentes**, adicione seus perfis e faça login. **Conta do terminal** usa a autenticação já disponível na CLI; perfis adicionados têm diretórios próprios.

Os seletores de modelo e permissões permanecem disponíveis durante uma execução. No Claude, modelo e permissões podem mudar no turno ativo; esforço e Fast valem para o próximo. No Codex, a configuração vale para o próximo turno, incluindo mensagens da fila. O esforço e os modelos disponíveis dependem do que a CLI da conta anuncia.

No terminal, **Ctrl+C** interrompe o processo mesmo quando há texto selecionado. Use **Ctrl+Shift+C** para copiar a seleção.

## Compilar e verificar

```powershell
npm run typecheck
node --test --test-concurrency=4 tests/*.test.cjs
npm run host:test
npm run build
```

Os testes automatizados usam dados fictícios e CLIs simuladas, com diretórios de dados temporários. Não é necessário enviar mensagens pagas a um provedor para executá-los. Alguns testes Node compilam ou executam o host; compile-o antes para reutilizar o binário local.

Para gerar o instalador Windows:

```powershell
npm run dist:win
```

O arquivo resultante fica em `dist-app/`. O repositório contém o código e os arquivos necessários ao build, sem instaladores, caches ou dados das suas contas. A geração de instaladores para macOS e Linux ainda não foi validada.

## Organização

| Diretório | Responsabilidade |
| --- | --- |
| `src/main/` | Janela Electron, integrações locais e IPC |
| `src/preload/` | Ponte segura entre a interface e os processos |
| `src/renderer/src/` | Interface React, estado, editor e componentes |
| `src/renderer/src/remote/` | Código-fonte da página móvel |
| `src/shared/` | Tipos e lógica compartilhados |
| `host/crates/` | Host, protocolo, armazenamento e execução dos agentes |
| `host/fixtures/`, `tests/`, `scripts/` | Contratos, testes e verificações visuais |

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para preparar o ambiente, validar mudanças e enviar um pull request. Relate problemas e sugestões nas [issues](https://github.com/q6r/Prism-IDE/issues). Use dados fictícios em exemplos e screenshots.

Para vulnerabilidades que possam expor arquivos, credenciais ou acesso remoto, siga [SECURITY.md](SECURITY.md) e use um relato privado.

## Licença e créditos

O código próprio do Prism IDE é disponibilizado sob a [licença MIT](LICENSE). Dependências, fontes, ícones, marcas e runtimes de terceiros seguem suas próprias licenças e condições; consulte [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Prism é um projeto independente, sem afiliação oficial com Anthropic, OpenAI ou Traycer.
