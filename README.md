# Análise DWG

Visualizador web de arquivos DWG/DXF com cálculo de áreas de polígonos fechados.
Todo o processamento acontece **no navegador** (WebAssembly). O arquivo não é enviado a nenhum servidor.

## Como executar

O navegador não carrega módulos JS/WebAssembly abrindo o `index.html` direto do disco (`file://`),
por isso é preciso um servidor local simples:

- **Windows:** dê dois cliques em `iniciar.bat` (abre http://localhost:8000).
- **Qualquer sistema:** `python -m http.server 8000` na pasta do projeto e acesse http://localhost:8000.

## Funcionalidades

- Abrir arquivo pelo botão ou **arrastando** o `.dwg`/`.dxf` para a janela.
- Renderização 2D: linhas, polilinhas (com arcos/bulges), círculos, arcos, elipses, splines, textos, MTEXT,
  blocos (INSERT, inclusive aninhados e em matriz), cotas, hachuras, sólidos, pontos e linhas de construção.
- **Zoom** com a roda do mouse (centrado no cursor), botões +/−, teclas `+`/`-`, gesto de pinça no celular;
  **mover** arrastando; **enquadrar** com duplo clique ou tecla `F`.
- Painel lateral direito:
  - **Resumo:** área total, nº de polígonos, maior e média; área por camada; dados do arquivo (versão, unidade,
    extensão, contagem de entidades por tipo); seletor da unidade do desenho.
  - **Polígonos:** lista de todos os polígonos fechados com área e perímetro, filtros por tipo/camada/texto,
    ordenação, clique para destacar e aproximar, e exportação para **CSV** (formato do Excel em português).
  - **Camadas:** ligar/desligar camadas (o desenho e os totais de área são atualizados).
- Clique no desenho para selecionar o polígono sob o cursor (cliques repetidos alternam entre polígonos sobrepostos).

## Como as áreas são calculadas

São considerados polígonos fechados:

| Entidade | Cálculo |
|---|---|
| Polilinha (LWPOLYLINE / POLYLINE 2D) fechada | Fórmula de Gauss (shoelace) **+ segmentos circulares exatos** dos arcos (bulge) |
| Círculo | π·r² |
| Elipse completa | π·a·b (perímetro pela aproximação de Ramanujan) |
| Spline fechada | Área do polígono amostrado da curva |
| Hachura | Soma dos contornos com regra par-ímpar (furos/ilhas são descontados) |

Polígonos dentro de blocos usam a escala do bloco. A conversão para m² usa a unidade do arquivo (`$INSUNITS`);
se o arquivo não tiver unidade definida, escolha-a em **Resumo › Unidade do desenho**.

> Atenção: polígonos sobrepostos (por exemplo, uma hachura sobre a polilinha do mesmo ambiente) são somados
> separadamente. Use os filtros de tipo e camada para obter a área útil desejada.

## Estrutura

```
index.html            página e painel lateral
css/style.css         estilos
js/app.js             carregamento, painel de informações, filtros e CSV
js/scene.js           conversão do DWG em primitivas 2D e extração dos polígonos
js/geometry.js        geometria: matrizes, OCS, arcos, bulges, NURBS e áreas
js/viewer.js          desenho em Canvas, zoom/pan e seleção
js/aci.js             paleta de cores do AutoCAD (ACI)
vendor/libredwg-web/  leitor DWG/DXF (libredwg compilado para WebAssembly, licença GPL-3.0)
```

## Limitações

- Sólidos 3D, MLINE, TOLERANCE, imagens raster e tabelas não são desenhados (aparecem como "não renderizados" no resumo).
- Hachuras com padrão aparecem como preenchimento translúcido (o padrão de linhas não é desenhado).
- Fontes SHX são substituídas por Arial; tipos de linha (tracejados) e espessuras são exibidos como linha contínua.
