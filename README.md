# Focus Lock Extension
<img width="1024" height="1024" alt="focus-locker-logo" src="https://github.com/user-attachments/assets/66f0f120-3b4e-40e6-85bd-a4390a4414ac" />

<br></br>
Extensão WebExtension (Manifest V3) para `Chrome`, `Edge` e `Firefox` que:

- Bloqueia qualquer site fora da whitelist durante sessão de foco.
- Conta tempo apenas com atividade real (aba permitida ativa + janela focada + interação recente).
- Aplica pausa por inatividade quando a página perde foco ou quando passa do tempo de inatividade configurado.
- Aplica punição opcional por atraso em pausa de inatividade (`+1 min` para cada `1 min` inativo, teto `+30 min`).
- Ao iniciar sessão, sugere o modo de acompanhamento: `Popup` ou `Visor flutuante` com timer/indicadores.
- Permite pausa manual com limite por sessão.
- Permite cadastrar apps externos manuais com toggle durante a sessão; ao ativar, abre uma janela externa de acompanhamento.
- Exibe player de YouTube/YouTube Music no visor flutuante (com link de fallback e controle único por aba).
- Exige confirmação no popup para liberar navegação até meia-noite local.
- Exporta/importa configurações + histórico em JSON.

## Estrutura

- `manifest.json`: declaração da extensão.
- `src/background.js`: máquina de estados da sessão, bloqueio e persistência.
- `src/content.js`: heartbeat de atividade.
- `src/popup.*`: UI principal e controles.
- `src/block.*`: página de bloqueio.
- `src/external-visor.*`: janela externa para acompanhamento durante apps externos.
- `src/shared/*`: utilidades puras (whitelist, tempo, punição, import/export, sessão).
- `tests/*`: testes unitários.

## Rodar testes

```bash
npm test
```

## Carregar no navegador (dev)

1. Abra a tela de extensões do navegador.
2. Ative modo desenvolvedor.
3. Escolha "Carregar sem compactação" (ou equivalente).
4. Selecione a pasta deste projeto.
5. (Opcional) Habilite a extensão também para modo anônimo.

### Firefox (extensão temporária)

O Firefox está com `background.service_worker` desativado por padrão. Para testes locais:

1. Gere a pasta de build: `npm run firefox:dev` (ou `bash scripts/build-firefox.sh`).
2. Em `about:debugging`, escolha “Load Temporary Add-on”.
3. Selecione `dist-firefox/manifest.json`.

## Fluxo de uso

1. Abra o popup da extensão.
2. Configure whitelist, duração da sessão, limite de pausa, minutos de inatividade e opção de punição por atraso.
3. (Opcional) Cadastre apps externos e/ou um link de música para o visor flutuante.
4. Clique em `Iniciar foco` e escolha `Usar popup` ou `Usar visor`.
5. Se estiver usando um app externo, ative o toggle correspondente para abrir a janela externa.
6. Ao término, abra o popup e clique em `Confirmar liberação do dia`.

## Limitação técnica (anti-burla)

Em navegadores pessoais, extensões não conseguem impedir 100% que o próprio usuário as desinstale/desative.
A extensão aplica bloqueio técnico dentro das APIs disponíveis e exibe aviso transparente sobre esse limite.

## Limitações conhecidas
- Alguns vídeos do YouTube não permitem reprodução embutida; use o link de fallback quando ocorrer.
