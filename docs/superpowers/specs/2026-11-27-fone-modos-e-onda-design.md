# bt-headset-battery: modos de áudio do QCY e onda do som

Desenho no canvas: pranchetas "Fone · modos de áudio" e "Fone · benchmark da onda" (quadro "✓ Escolhida · transformando 1 → 2 → 4 → 6").

## Por quê

O Pedro troca o modo do QCY MeloBuds N20 (Normal, ANC adaptativo, Ambiente) pelo app do iPhone. Quer trocar pelo widget de bateria que já está na barra, e ver o som do computador numa onda bonita quando abre o painel.

## Objetivos

- Clique no ícone do fone abre um menu: nome, bateria, a onda e "Modo de áudio" com Normal, ANC adaptativo e Ambiente.
- Cada modo tem ícone (fone, escudo, orelha com ondas). Não selecionado: texto e ícone cinza. Selecionado: texto e ícone na cor do modo (Normal verde `#57e389`, ANC azul `#62a0ea`, Ambiente amarelo `#f6d32d`), negrito. Nenhum fundo colorido fixo; hover só o cinza claro do GNOME.
- Clicar num modo troca na hora; o destaque segue o que o fone confirma. Sem confirmação em ~2 s, volta ao anterior e mostra "Não deu para trocar".
- Na barra, com ANC ou Ambiente: etiqueta "ANC"/"AMB" só com o texto na cor do modo. No Normal, nada muda.
- Onda: som que está saindo no computador, em tempo real, na cor do modo. Quatro estilos em ciclo — barras espelhadas, Siri (3 curvas), curva preenchida, pontos — cada um ~8 s, e a troca é uma transformação coluna a coluna da direita para a esquerda (frente de 3 s, cada coluna 1,2 s), sem fade, sem degrau. Em silêncio, a onda fica parada e cinza.
- A captura do som e o desenho só rodam com o painel aberto.
- Fone sem esse controle (JBL e outros): o menu mostra só nome e bateria.

## Não objetivos

- Equalizador, toques, nível de ANC, outros modos de ANC (vento, interno…), outros modelos QCY além do N20 confirmados.

## Anti-objetivos

- Mandar ao fone qualquer comando além dos três de modo e da leitura do modo.
- Escrever em canal que não seja o característico `00000001` do serviço `a002` (o outro canal pode ser de firmware).
- Rodar captura de áudio, BLE ou animação com o painel fechado.
- Usar o microfone.

## Como (decidido e testado)

- Protocolo (testado no N20 em 2026-11-27): chip JieLi AC697, BLE no endereço anunciado com fabricante `0x521c` (21020) e `vendorId` 32884 (bytes 0–1 do dado de fabricante); serviço `0000a002-…`, escrita em `00000001-…` (write-without-response), avisos em `00000002-…`. Sem autenticação.
- Quadro RCSP: `FE DC BA | C0 | FF | len(2, BE) | sn | dados | EF`. Ler modo: dados `FE 01 17`. Trocar: `17 03 m s n` com Normal `02 00 00`, ANC adaptativo `01 05 00`, Ambiente `03 01 04`. Resposta à leitura: `FE DC BA 00 FF 00 07 00 sn 17 03 m s n EF`; aviso espontâneo de troca: `FE DC BA 80 FF 00 06 sn 17 03 m s n EF`.
- Som: `pw-record -P '{ stream.capture.sink=true }' --rate 16000 --channels 1 --format s16 -` (monitor da saída padrão), lido em blocos; níveis por coluna via FFT.

## Decisões do Claude (conferir)

- Conexão BLE só com o painel aberto: ao abrir, procura o fone (busca BLE de até ~6 s se o BlueZ não o conhece), conecta, lê o modo; ao fechar, desconecta. A etiqueta da barra mostra o último modo lido; uma troca pelo toque no fone com o painel fechado só aparece na próxima abertura.
- O fone QCY é reconhecido pelo dado de fabricante cujo "control MAC" é o endereço do fone conectado no Bluetooth clássico.
- 40 colunas, onda de 280×56 px, ~30 quadros por segundo.

## Deixado para quem constrói

- Divisão em arquivos, formato da FFT, suavização dos níveis, tempo exato de cada estilo.
