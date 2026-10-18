# Third-party notices

Prism-authored code is covered by the repository's [MIT license](LICENSE). Third-party code, fonts, icons, dependencies and runtimes retain their own copyrights, licenses and terms. The Prism license does not relicense them.

The [dependency index](third-party-licenses/README.md) contains the complete license and notice files available for the installed production npm dependencies. [SOURCES.json](third-party-licenses/SOURCES.json) records package versions, file hashes and the source of each notice. Additional runtime components obtained during installation or at runtime remain separately licensed.

## Traycer UI references

Prism's UI includes adapted component and style recipes identified in its source comments from [Traycer's public GUI sources](https://github.com/traycerai/traycer). Traycer's upstream repository is MIT licensed, copyright (c) 2026 Traycer AI. Its [full license](third-party-licenses/references/traycer/LICENSE) is retained here. Prism-specific adaptations use the repository's Prism license and do not remove Traycer's attribution.

## Provider and language icons

- Claude Color and Codex Mono provider marks use [LobeHub Icons](https://github.com/lobehub/lobe-icons), copyright (c) 2023 LobeHub, under the [MIT license](third-party-licenses/references/lobe-icons/LICENSE). The Codex geometry is from the upstream [Codex Mono component](https://github.com/lobehub/lobe-icons/blob/master/src/Codex/components/Mono.tsx).
- Discord presence language icons are referenced from [vscord's icon assets](https://github.com/leonardssh/vscord/tree/main/assets/icons) through its public CDN. vscord's [MIT license](third-party-licenses/references/vscord/LICENSE) credits iCrawl, Satoqz and Narcis B.
- The Discord icon used through `react-icons/fa6` comes from Font Awesome Free 6.5.2, Fonticons, Inc. The SVG/JavaScript icon artwork is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the upstream [Font Awesome license and attribution](third-party-licenses/references/font-awesome-6/LICENSE.txt) are included. `react-icons` converts it into a React component and retains its own [MIT license and collection notices](third-party-licenses/npm/react-icons@5.6.0/LICENSE).
- UI icons from Lucide retain the [ISC license and the included Feather MIT attribution](third-party-licenses/npm/lucide-react@1.18.0/LICENSE), copyright Lucide Icons and Contributors and Cole Bemis for the identified Feather-derived icons.

Provider and product names and logos are trademarks of their respective owners. Their use identifies the corresponding integration or service and does not imply endorsement, sponsorship or affiliation.

## Font

The Figtree font, copyright 2022 The Figtree Project Authors, is distributed through `@fontsource-variable/figtree` under the [SIL Open Font License 1.1](third-party-licenses/npm/fontsource-variable__figtree@5.3.0/LICENSE). Prism uses the packaged font files, including an embedded copy in the generated mobile page. The font retains the OFL and is not relicensed under Prism's MIT license.

## Editor, trees, diffs and charts

- `@pierre/diffs`, `@pierre/theme`, `@pierre/theming` and `@pierre/trees` are Apache-2.0 licensed. Their full license texts are in the dependency index. The [theme notice](third-party-licenses/npm/pierre__theme@2.0.0/NOTICE.md) retains the MIT attribution for Primer's GitHub VS Code Theme. The [trees notice](third-party-licenses/npm/pierre__trees@1.0.0-beta.6/NOTICE.md) retains the MIT attribution for Lukas Bach's `@headless-tree/core`.
- Monaco Editor retains its [MIT license](third-party-licenses/npm/monaco-editor@0.55.1/LICENSE) and [third-party notices](third-party-licenses/npm/monaco-editor@0.55.1/ThirdPartyNotices.txt).
- React Virtuoso retains its [MIT license](third-party-licenses/npm/react-virtuoso@4.18.16/LICENSE), copyright (c) 2020 Petyo Ivanov.
- Apache ECharts retains its [Apache-2.0 license](third-party-licenses/npm/echarts@6.1.0/LICENSE) and [NOTICE](third-party-licenses/npm/echarts@6.1.0/NOTICE). The renderer dependency `zrender` retains its own notice in the dependency index.

React, React DOM, Markdown processing libraries, terminal libraries and other dependencies are listed with their individual licenses in the [dependency index](third-party-licenses/README.md). These notices also cover the corresponding frontend code bundled into the generated remote-control page.

## Agent SDKs and runtime software

The Claude Agent SDK and Claude Code native packages are not covered by Prism's MIT license. Their supplied [Anthropic license notice](third-party-licenses/npm/anthropic-ai__claude-agent-sdk@0.3.295/LICENSE.md) and [native package notice](third-party-licenses/npm/anthropic-ai__claude-agent-sdk-win32-x64@0.3.177/LICENSE.md) refer to the [applicable Anthropic agreements](https://code.claude.com/docs/en/legal-and-compliance). The separate `@anthropic-ai/sdk` API client retains its own MIT license in the dependency index.

Electron is separately licensed; its [license](third-party-licenses/runtime/electron/LICENSE) is included for attribution. Binary Electron distributions also supply `LICENSE.electron.txt` and Chromium's `LICENSES.chromium.html`; these must remain with the corresponding runtime distribution. Provider CLIs and downloaded tunnel software retain their upstream terms. This source publication does not place those executables under the Prism license or vendor them into this repository.

The Rust host's dependencies are specified by `host/Cargo.toml` and `host/Cargo.lock`; their source is obtained through Cargo and retains its upstream licenses. No third-party Rust dependency implementation is vendored in this source checkout.
