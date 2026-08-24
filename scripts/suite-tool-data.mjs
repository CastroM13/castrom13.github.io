const LOCAL_PRIVACY = {
  en: 'Files and inputs stay in this tab · No uploads or analytics',
  pt: 'Arquivos e entradas ficam nesta aba · Sem uploads ou métricas'
};

const MODEL_PRIVACY = {
  en: 'Media stays local · Optional runtime or model downloads are disclosed first',
  pt: 'A mídia fica no dispositivo · Downloads opcionais de runtime ou modelo são informados antes'
};

function define(index, key, {
  title, subtitle, description, note, limits,
  status = ['Local processing', 'Processamento local'],
  privacy = LOCAL_PRIVACY,
  schemaCategory = 'UtilitiesApplication'
}) {
  return {
    key,
    index: String(index).padStart(2, '0'),
    schemaCategory,
    status: { en: status[0], pt: status[1] },
    title: { en: title[0], pt: title[1] },
    subtitle: { en: subtitle[0], pt: subtitle[1] },
    description: { en: description[0], pt: description[1] },
    privacy,
    paths: { en: `/tools/${key}/`, pt: `/pt-br/ferramentas/${key}/` },
    note: { en: note[0], pt: note[1] },
    limits: { en: limits[0], pt: limits[1] },
    script: '/assets/tools/lab-suite.js'
  };
}

const entries = [
  ['universal-image-converter', {
    title: ['Universal Image Converter', 'Conversor universal de imagens'],
    subtitle: ['Format conversion, resize, and quality control', 'Conversão, redimensionamento e qualidade'],
    description: ['Convert supported PNG, JPEG, WebP, AVIF, TIFF, and BMP images locally, resize them, and tune lossy quality.', 'Converta localmente imagens PNG, JPEG, WebP, AVIF, TIFF e BMP compatíveis, redimensione e ajuste a qualidade.'],
    note: ['Browser codecs handle PNG/JPEG/WebP while site-hosted libavif, UTIF, and baseline BMP paths provide genuine AVIF, TIFF, and BMP encoding.', 'Codecs do navegador processam PNG/JPEG/WebP enquanto caminhos libavif, UTIF e BMP baseline hospedados no site fornecem codificação AVIF, TIFF e BMP genuína.'],
    limits: ['Browser PNG/JPEG/WebP support is detected at runtime; bundled AVIF/TIFF/BMP paths validate their output signatures, and output is capped at 256 MiB.', 'O suporte do navegador a PNG/JPEG/WebP é detectado em tempo real; caminhos AVIF/TIFF/BMP incluídos validam as assinaturas de saída, e a saída é limitada a 256 MiB.'],
    status: ['Canvas · TIFF · BMP', 'Canvas · TIFF · BMP'], schemaCategory: 'MultimediaApplication'
  }],
  ['image-compressor', {
    title: ['Image Compressor', 'Compressor de imagens'],
    subtitle: ['Batch compression with visual comparison', 'Compressão em lote com comparação visual'],
    description: ['Compress image batches, strip recognized metadata through re-encoding, and compare size and quality before download.', 'Comprima lotes de imagens, remova metadados reconhecidos por recodificação e compare tamanho e qualidade antes de baixar.'],
    note: ['Each output is a fresh encoding; the report records source/result sizes plus bounded pixel-fidelity PSNR and RMSE measurements.', 'Cada saída é uma nova codificação; o relatório registra os tamanhos de origem/resultado e medições limitadas de fidelidade por pixels com PSNR e RMSE.'],
    limits: ['PSNR and RMSE are measured on a bounded downsample and are not perceptual scores or a substitute for visual review.', 'PSNR e RMSE são medidos em uma amostra reduzida limitada; não são métricas perceptuais nem substituem revisão visual.'],
    status: ['Batch · Local', 'Lote · Local'], schemaCategory: 'MultimediaApplication'
  }],
  ['raw-photo-processor', {
    title: ['RAW Photo Processor', 'Processador de fotos RAW'],
    subtitle: ['LibRaw sensor development to JPEG or TIFF', 'Revelação de sensor com LibRaw para JPEG ou TIFF'],
    description: ['Develop supported CR2, NEF, ARW, DNG, and other RAW sensor files locally with exposure, camera/auto/custom white balance, and half/full-resolution controls.', 'Revele localmente arquivos de sensor CR2, NEF, ARW, DNG e outros RAW compatíveis, com exposição, balanço de branco da câmera/automático/personalizado e meia/resolução completa.'],
    note: ['A disposable LibRaw worker demosaics sensor data and returns fresh 8-bit sRGB JPEG or baseline TIFF output.', 'Um worker descartável LibRaw faz o demosaico dos dados do sensor e retorna JPEG sRGB de 8 bits ou TIFF baseline novos.'],
    limits: ['Input is capped at 128 MiB and developed pixels at 40 MP; lens profiles, nondestructive RAW sidecars, and original-file mutation are outside this developer.', 'A entrada é limitada a 128 MiB e os pixels revelados a 40 MP; perfis de lente, sidecars RAW não destrutivos e alteração do original ficam fora deste revelador.'],
    status: ['LibRaw WASM', 'LibRaw WASM'], schemaCategory: 'MultimediaApplication'
  }],
  ['svg-studio', {
    title: ['SVG Optimizer & Editor', 'Otimizador e editor de SVG'],
    subtitle: ['Inspect, optimize, transform, and export SVG', 'Inspecione, otimize, transforme e exporte SVG'],
    description: ['Edit SVG source, remove safe redundancies, inspect paths, apply view transformations, preview, and export locally.', 'Edite o código SVG, remova redundâncias seguras, inspecione paths, aplique transformações, visualize e exporte localmente.'],
    note: ['SVG is parsed as XML, sanitized for active content, normalized, and rendered in an isolated preview.', 'O SVG é interpretado como XML, sanitizado contra conteúdo ativo, normalizado e renderizado em uma prévia isolada.'],
    limits: ['Optimization is conservative and does not rewrite path geometry; always compare complex filters, fonts, and animations.', 'A otimização é conservadora e não reescreve a geometria dos paths; compare filtros, fontes e animações complexas.'],
    status: ['XML · Local', 'XML · Local'], schemaCategory: 'DesignApplication'
  }],
  ['image-metadata-workbench', {
    title: ['Image Metadata Workbench', 'Bancada de metadados de imagens'],
    subtitle: ['Inspect, edit, or remove EXIF, IPTC, and XMP', 'Inspecione, edite ou remova EXIF, IPTC e XMP'],
    description: ['Inspect image metadata, write real EXIF ImageDescription, IPTC Caption-Abstract, or XMP dc:description fields in JPEG, remove recognized JPEG/PNG blocks, and export a local copy.', 'Inspecione metadados de imagem, grave campos EXIF ImageDescription, IPTC Caption-Abstract ou XMP dc:description reais em JPEG, remova blocos JPEG/PNG reconhecidos e exporte uma cópia local.'],
    note: ['Namespace-specific JPEG edits preserve unrelated segments; removal is broader and explicitly targets recognized APP/chunk families.', 'Edições JPEG específicas por namespace preservam segmentos não relacionados; a remoção é mais ampla e atinge explicitamente famílias APP/chunks reconhecidas.'],
    limits: ['Unknown maker notes and proprietary metadata are reported but never rewritten as structured fields.', 'Maker notes desconhecidas e metadados proprietários são informados, mas não reescritos como campos estruturados.'],
    status: ['EXIF · XMP', 'EXIF · XMP'], schemaCategory: 'MultimediaApplication'
  }],
  ['ocr-studio', {
    title: ['OCR Studio', 'Estúdio de OCR'],
    subtitle: ['Local text recognition and searchable export', 'Reconhecimento local e exportação pesquisável'],
    description: ['Recognize text in local images, preserve word boxes, select a language, and export text or a searchable PDF when the OCR runtime is available.', 'Reconheça texto em imagens locais, preserve caixas de palavras, escolha o idioma e exporte texto ou PDF pesquisável quando o runtime estiver disponível.'],
    note: ['Recognition starts only after an explicit action; images stay local while an optional OCR runtime and language data may be downloaded.', 'O reconhecimento começa somente após uma ação explícita; as imagens ficam locais enquanto runtime e idioma opcionais podem ser baixados.'],
    limits: ['Accuracy depends on language data, typography, resolution, orientation, and device resources; review every result.', 'A precisão depende do idioma, tipografia, resolução, orientação e recursos do dispositivo; revise todo resultado.'],
    status: ['On-device OCR', 'OCR no dispositivo'], privacy: MODEL_PRIVACY, schemaCategory: 'MultimediaApplication'
  }],
  ['document-scanner', {
    title: ['Document Scanner', 'Scanner de documentos'],
    subtitle: ['Crop, deskew, threshold, and clean scans', 'Recorte, alinhe, binarize e limpe scans'],
    description: ['Correct document framing, rotate or deskew, tune threshold and contrast, and export a cleaned local scan.', 'Corrija o enquadramento, gire ou alinhe, ajuste limiar e contraste e exporte um scan limpo localmente.'],
    note: ['Pixel operations run on a capped canvas and the before/after preview remains on this device.', 'As operações de pixels rodam em um canvas limitado e a prévia antes/depois permanece no dispositivo.'],
    limits: ['Automatic edge and skew estimates can fail on low-contrast or curved pages; manual controls remain available.', 'A estimativa automática de bordas e inclinação pode falhar em páginas curvas ou com pouco contraste; controles manuais continuam disponíveis.'],
    status: ['Canvas vision', 'Visão em canvas'], schemaCategory: 'MultimediaApplication'
  }],
  ['panorama-stitcher', {
    title: ['Panorama Stitcher', 'Montador de panoramas'],
    subtitle: ['Align, blend, and join photographs', 'Alinhe, mescle e una fotografias'],
    description: ['Order photographs, estimate horizontal overlap, fine-tune alignment, blend seams, and export a panorama locally.', 'Ordene fotografias, estime a sobreposição horizontal, refine o alinhamento, mescle emendas e exporte um panorama localmente.'],
    note: ['A downsampled luminance search estimates adjacent overlap before full-resolution canvas blending.', 'Uma busca de luminância reduzida estima a sobreposição entre imagens antes da mesclagem em resolução final.'],
    limits: ['The aligner targets mostly horizontal, low-parallax sequences and does not perform lens calibration or spherical projection.', 'O alinhador é voltado a sequências horizontais com pouca paralaxe e não calibra lente nem faz projeção esférica.'],
    status: ['Local alignment', 'Alinhamento local'], schemaCategory: 'MultimediaApplication'
  }],
  ['hdr-merger', {
    title: ['HDR Image Merger', 'Mesclador de imagens HDR'],
    subtitle: ['Merge exposure stacks and tone-map locally', 'Mescle exposições e aplique tone mapping'],
    description: ['Combine aligned exposure stacks, reject clipped samples, tune tone mapping, and export a display-ready image.', 'Combine pilhas de exposição alinhadas, rejeite amostras estouradas, ajuste tone mapping e exporte uma imagem pronta para exibição.'],
    note: ['Linearized pixel samples are weighted by exposure confidence and mapped back to a viewable local image.', 'Amostras de pixels linearizadas recebem pesos por confiança de exposição e voltam a uma imagem local visível.'],
    limits: ['Inputs must share dimensions and framing; this tool does not remove motion ghosts or estimate camera response curves.', 'As entradas precisam compartilhar dimensões e enquadramento; a ferramenta não remove fantasmas de movimento nem estima a curva da câmera.'],
    status: ['Tone mapping', 'Tone mapping'], schemaCategory: 'MultimediaApplication'
  }],
  ['pixel-texture-editor', {
    title: ['Pixel / Texture Editor', 'Editor de pixels e texturas'],
    subtitle: ['Layers, masks, brushes, filters, and blending', 'Camadas, máscaras, pincéis, filtros e mesclagem'],
    description: ['Paint on local images with layers, opacity and blend controls, masks, undo, and practical texture filters, then export a flattened copy.', 'Pinte em imagens locais com camadas, opacidade, mesclagem, máscaras, desfazer e filtros para texturas e exporte uma cópia achatada.'],
    note: ['Edits are retained as capped in-memory canvas layers until you flatten and download the composition.', 'As edições ficam em camadas de canvas limitadas na memória até você achatar e baixar a composição.'],
    limits: ['This focused editor does not import PSD files or preserve layers in exported PNG and WebP files.', 'Este editor focado não importa PSD nem preserva camadas nos arquivos PNG e WebP exportados.'],
    status: ['Canvas layers', 'Camadas em canvas'], schemaCategory: 'DesignApplication'
  }],
  ['offline-video-player', {
    title: ['Offline Video Player', 'Player de vídeo offline'],
    subtitle: ['Local playback, subtitles, and media inspection', 'Reprodução local, legendas e inspeção'],
    description: ['Play local media through a zero-copy native path or a disclosed FFmpeg compatibility transcode, add VTT/SRT subtitles, choose an audio stream, inspect metadata, and capture frames.', 'Reproduza mídia local pelo caminho nativo sem cópia ou por transcodificação de compatibilidade FFmpeg informada, adicione legendas VTT/SRT, escolha uma faixa de áudio, inspecione metadados e capture quadros.'],
    note: ['Auto mode tries the original Blob URL first and loads the vendored FFmpeg core only after a real decode or audio-selection failure.', 'O modo Automático tenta primeiro a URL Blob original e carrega o núcleo FFmpeg incluído apenas após falha real de decodificação ou seleção de áudio.'],
    limits: ['The FFmpeg fallback is capped at 192 MiB and 10 minutes and creates a compatibility MP4 or WebM that omits extra tracks, chapters, attachments, embedded subtitles, metadata, and HDR signaling.', 'O fallback FFmpeg é limitado a 192 MiB e 10 minutos e cria MP4 ou WebM de compatibilidade sem faixas extras, capítulos, anexos, legendas embutidas, metadados e sinalização HDR.'],
    status: ['Native + FFmpeg', 'Nativo + FFmpeg'], schemaCategory: 'MultimediaApplication'
  }],
  ['video-converter', {
    title: ['Video Converter', 'Conversor de vídeo'],
    subtitle: ['FFmpeg MP4/WebM transcoding with streaming fallback', 'Transcodificação FFmpeg MP4/WebM com fallback em fluxo'],
    description: ['Transcode local video to VP9/Opus WebM or H.264/AAC MP4 with resolution, bitrate, and frame-rate controls entirely in this tab.', 'Transcodifique vídeo local para WebM VP9/Opus ou MP4 H.264/AAC com controles de resolução, bitrate e quadros inteiramente nesta aba.'],
    note: ['The primary path uses the vendored FFmpeg WASM codec core; a separately selected MediaRecorder path handles browser-decodable WebM in real time.', 'O caminho principal usa o núcleo de codecs FFmpeg WASM incluído; um caminho MediaRecorder selecionado separadamente processa WebM decodificável pelo navegador em tempo real.'],
    limits: ['FFmpeg input is capped at 192 MiB / 10 minutes and output at 256 MiB; the streaming fallback is capped at 2 minutes and only emits supported WebM.', 'A entrada FFmpeg é limitada a 192 MiB / 10 minutos e a saída a 256 MiB; o fallback em fluxo é limitado a 2 minutos e só gera WebM compatível.'],
    status: ['FFmpeg WASM', 'FFmpeg WASM'], schemaCategory: 'MultimediaApplication'
  }],
  ['video-compressor', {
    title: ['Video Compressor', 'Compressor de vídeo'],
    subtitle: ['Resolution, bitrate, codec, and size planning', 'Resolução, bitrate, codec e tamanho'],
    description: ['Estimate size, choose bounded resolution/bitrate/frame-rate presets, and compress local video to VP9/Opus WebM or H.264/AAC MP4 with FFmpeg WASM.', 'Estime o tamanho, escolha predefinições limitadas de resolução/bitrate/quadros e comprima vídeo local para WebM VP9/Opus ou MP4 H.264/AAC com FFmpeg WASM.'],
    note: ['The report compares bitrate-based planning with the actual measured output and records the codec engine and source ratio.', 'O relatório compara o planejamento por bitrate com a saída real medida e registra o motor de codecs e a proporção da origem.'],
    limits: ['Bitrate is a target, metadata and extra streams are not preserved, and FFmpeg input/output/time caps remain 192 MiB, 256 MiB, and 10 minutes.', 'O bitrate é um alvo, metadados e fluxos extras não são preservados e os limites FFmpeg de entrada/saída/tempo são 192 MiB, 256 MiB e 10 minutos.'],
    status: ['FFmpeg compression', 'Compressão FFmpeg'], schemaCategory: 'MultimediaApplication'
  }],
  ['video-editor', {
    title: ['Video Editor', 'Editor de vídeo'],
    subtitle: ['Trim, title, preview, and export a timeline', 'Corte, titule, visualize e exporte'],
    description: ['Trim a local clip, add timed text in the browser path, apply bounded fade-in/out transitions, choose framing and audio, preview, and export WebM or FFmpeg MP4/WebM.', 'Corte um clipe local, adicione texto no caminho do navegador, aplique transições limitadas de fade de entrada/saída, escolha enquadramento e áudio, visualize e exporte WebM ou MP4/WebM por FFmpeg.'],
    note: ['The browser path composes text and fades on canvas; the lazy FFmpeg path handles broader codecs and applies the same visual edge fade.', 'O caminho do navegador compõe texto e fades em canvas; o caminho FFmpeg sob demanda processa mais codecs e aplica o mesmo fade visual nas bordas.'],
    limits: ['This single-clip editor provides cuts, fades, text, and audio passthrough where supported; it is not a multisequence NLE.', 'Este editor de clipe único oferece cortes, fades, texto e áudio quando compatível; não é um editor multipista completo.'],
    status: ['Timeline · Local', 'Timeline · Local'], schemaCategory: 'MultimediaApplication'
  }],
  ['animation-studio', {
    title: ['GIF / WebP / APNG Studio', 'Estúdio de GIF / WebP / APNG'],
    subtitle: ['Frame editing, timing, preview, and export', 'Edição de quadros, tempo, prévia e exportação'],
    description: ['Build GIF, animated WebP, or APNG from reordered and independently timed frames; render frames to WebM or a sprite sheet; or convert a clipped video into an animation.', 'Crie GIF, WebP animado ou APNG com quadros reordenados e tempos independentes; renderize quadros em WebM ou sprite sheet; ou converta um trecho de vídeo em animação.'],
    note: ['GIF palette quantization runs locally; animated WebP/APNG and video conversion lazily load the vendored FFmpeg codec core.', 'A quantização de paleta GIF roda localmente; WebP/APNG animados e conversão de vídeo carregam sob demanda o núcleo de codecs FFmpeg incluído.'],
    limits: ['Runs are capped at 120 seconds, canvas output at 2.2 MP per frame, retained animation output at 128 MiB, and frame batches by aggregate pixel budgets.', 'Execuções são limitadas a 120 segundos, cada quadro a 2,2 MP, a saída retida a 128 MiB e lotes de quadros por orçamento agregado de pixels.'],
    status: ['Frames + FFmpeg', 'Quadros + FFmpeg'], schemaCategory: 'MultimediaApplication'
  }],
  ['subtitle-editor', {
    title: ['Subtitle Editor', 'Editor de legendas'],
    subtitle: ['SRT, VTT, and ASS timing workbench', 'Bancada de tempo para SRT, VTT e ASS'],
    description: ['Parse SRT, VTT, and ASS subtitles, edit cues, shift or scale timing, validate overlaps, preview, and export.', 'Interprete legendas SRT, VTT e ASS, edite falas, desloque ou escale tempos, valide sobreposições, visualize e exporte.'],
    note: ['Cues are normalized to milliseconds in memory and serialized back to the selected subtitle format.', 'As falas são normalizadas em milissegundos na memória e serializadas no formato escolhido.'],
    limits: ['Advanced ASS positioning and style effects are preserved as source fields but the built-in preview renders plain text.', 'Posicionamento e efeitos avançados de ASS são preservados nos campos de origem, mas a prévia interna renderiza texto simples.'],
    status: ['SRT · VTT · ASS', 'SRT · VTT · ASS'], schemaCategory: 'MultimediaApplication'
  }],
  ['audio-converter', {
    title: ['Audio Converter', 'Conversor de áudio'],
    subtitle: ['Decode, resample, and export local audio', 'Decodifique, reamostre e exporte áudio'],
    description: ['Decode local audio, trim, resample, remix channels, and export genuine WAV, FLAC, MP3, Opus, or AAC/M4A output.', 'Decodifique áudio local, recorte, reamostre, remixe canais e exporte saída genuína WAV, FLAC, MP3, Opus ou AAC/M4A.'],
    note: ['WAV uses the tested PCM encoder; compressed formats lazily load the vendored FFmpeg WASM codec core.', 'WAV usa o codificador PCM testado; formatos comprimidos carregam sob demanda o núcleo de codecs FFmpeg WASM incluído.'],
    limits: ['Browser decoding remains codec-dependent; FFmpeg conversion is capped at 200 MiB input and 30 minutes per run.', 'A decodificação pelo navegador continua dependente do codec; a conversão FFmpeg é limitada a 200 MiB de entrada e 30 minutos por execução.'],
    status: ['PCM + FFmpeg', 'PCM + FFmpeg'], schemaCategory: 'MultimediaApplication'
  }],
  ['daw-lite', {
    title: ['DAW-lite', 'DAW-lite'],
    subtitle: ['Multitrack mixing and effects', 'Mixagem multipista e efeitos'],
    description: ['Arrange local audio tracks, set trims, gain and pan, apply fades and filters, preview the mix, and export a stereo WAV.', 'Organize faixas locais, ajuste cortes, ganho e panorama, aplique fades e filtros, ouça e exporte um WAV estéreo.'],
    note: ['A deterministic typed-array mixer applies trims, per-track fades, low-pass filtering, gain, pan, offsets, and peak limiting before WAV export.', 'Um mixer determinístico em arrays tipados aplica cortes, fades por faixa, filtro passa-baixas, ganho, panorama, deslocamentos e limitação de pico antes do WAV.'],
    limits: ['Projects live only in this tab and the compact mixer does not support plug-in formats, MIDI, or automation curves.', 'Projetos existem somente nesta aba e o mixer compacto não aceita plug-ins, MIDI nem curvas de automação.'],
    status: ['PCM multitrack', 'PCM multipista'], schemaCategory: 'MultimediaApplication'
  }],
  ['audio-restoration', {
    title: ['Audio Restoration Tool', 'Ferramenta de restauração de áudio'],
    subtitle: ['Noise gate, EQ, normalization, and silence', 'Noise gate, EQ, normalização e silêncio'],
    description: ['Analyze local audio, attenuate stationary noise, apply high-pass and low-pass filters, normalize peaks, detect silence, and export WAV.', 'Analise áudio local, atenue ruído estacionário, aplique filtros, normalize picos, detecte silêncio e exporte WAV.'],
    note: ['Deterministic DSP runs on decoded PCM and reports measured input/output peaks plus reviewable windowed-RMS silence intervals in downloadable JSON.', 'DSP determinístico roda no PCM decodificado e informa picos de entrada/saída e intervalos de silêncio revisáveis por RMS em janelas em JSON baixável.'],
    limits: ['The noise reducer is a transparent gate/filter chain, not a neural source separator; audition results before use.', 'O redutor é uma cadeia transparente de gate e filtros, não um separador neural; ouça o resultado antes de usar.'],
    status: ['Local DSP', 'DSP local'], schemaCategory: 'MultimediaApplication'
  }],
  ['music-analyzer', {
    title: ['Music Analyzer', 'Analisador musical'],
    subtitle: ['Tempo, key, loudness, onsets, and spectrum', 'Tempo, tom, loudness, ataques e espectro'],
    description: ['Estimate BPM and musical key, measure loudness, detect onsets, inspect a spectrogram, and export an analysis report.', 'Estime BPM e tom musical, meça loudness, detecte ataques, inspecione um espectrograma e exporte um relatório.'],
    note: ['The analyzer derives energy, onset-envelope, log-frequency Goertzel spectrogram, chroma, and autocorrelation features from capped decoded PCM.', 'O analisador extrai energia, envelope de ataques, espectrograma Goertzel em frequência logarítmica, croma e autocorrelação de PCM decodificado e limitado.'],
    limits: ['BPM and key are estimates and can be ambiguous for live, rubato, noisy, or harmonically complex recordings.', 'BPM e tom são estimativas e podem ser ambíguos em gravações ao vivo, rubato, ruidosas ou harmonicamente complexas.'],
    status: ['Audio analysis', 'Análise de áudio'], schemaCategory: 'MultimediaApplication'
  }],
  ['pdf-toolbox', {
    title: ['PDF Toolbox', 'Caixa de ferramentas PDF'],
    subtitle: ['Merge, split, rotate, reorder, and compact PDFs', 'Una, divida, gire, reordene e compacte PDFs'],
    description: ['Merge PDFs, select and reorder pages, rotate, split, remove common metadata, and save a structurally compact copy locally.', 'Una PDFs, selecione e reordene páginas, gire, divida, remova metadados comuns e salve uma cópia estruturalmente compacta.'],
    note: ['A lazily loaded local PDF library copies selected pages into new documents and reports output size.', 'Uma biblioteca PDF local carregada sob demanda copia as páginas selecionadas em novos documentos e informa o tamanho.'],
    limits: ['Structural rewriting does not recompress every embedded image or guarantee secure removal of prior incremental revisions.', 'A reescrita estrutural não recomprime toda imagem embutida nem garante remoção segura de revisões incrementais anteriores.'],
    status: ['Local PDF', 'PDF local'], schemaCategory: 'UtilitiesApplication'
  }],
  ['pdf-editor', {
    title: ['PDF Editor', 'Editor de PDF'],
    subtitle: ['Annotate, fill, sign, and manipulate pages', 'Anote, preencha, assine e manipule páginas'],
    description: ['Add text and drawn signatures, fill existing form fields, rotate or remove pages, and export an edited local PDF.', 'Adicione texto e assinaturas desenhadas, preencha campos existentes, gire ou remova páginas e exporte um PDF editado localmente.'],
    note: ['Edits are applied to a copied document after you review page and form inventories.', 'As edições são aplicadas em uma cópia após você revisar o inventário de páginas e formulários.'],
    limits: ['Drawn signatures are visual marks, not cryptographic digital signatures; complex appearance streams may render differently.', 'Assinaturas desenhadas são marcas visuais, não assinaturas digitais criptográficas; aparências complexas podem variar.'],
    status: ['Annotations · Forms', 'Anotações · Formulários'], schemaCategory: 'UtilitiesApplication'
  }],
  ['office-viewer', {
    title: ['Office Document Viewer', 'Visualizador de documentos Office'],
    subtitle: ['Private DOCX, XLSX, and PPTX inspection', 'Inspeção privada de DOCX, XLSX e PPTX'],
    description: ['Open OOXML DOCX, XLSX, and PPTX packages, inspect structure, and render readable text, tables, and slide outlines without upload.', 'Abra pacotes OOXML DOCX, XLSX e PPTX, inspecione a estrutura e renderize texto, tabelas e tópicos de slides sem upload.'],
    note: ['The viewer reads ZIP/XML parts locally and builds a safe semantic preview instead of executing macros or embedded content.', 'O visualizador lê partes ZIP/XML localmente e cria uma prévia semântica segura sem executar macros nem conteúdo embutido.'],
    limits: ['This is a semantic viewer, not a pixel-perfect Office renderer; legacy binary files, macros, charts, and complex layout are not executed.', 'É um visualizador semântico, não uma renderização idêntica ao Office; arquivos binários antigos, macros, gráficos e layout complexo não são executados.'],
    status: ['OOXML · Local', 'OOXML · Local'], schemaCategory: 'UtilitiesApplication'
  }],
  ['epub-studio', {
    title: ['EPUB Studio', 'Estúdio de EPUB'],
    subtitle: ['Read, edit metadata and TOC, validate, export', 'Leia, edite metadados e sumário, valide e exporte'],
    description: ['Open EPUB packages, read chapters, edit metadata and table of contents, validate required structure, and export a new EPUB.', 'Abra EPUBs, leia capítulos, edite metadados e sumário, valide a estrutura obrigatória e exporte um novo EPUB.'],
    note: ['The studio safely parses the ZIP container, OPF package, navigation documents, and XHTML chapters in memory.', 'O estúdio interpreta com segurança o ZIP, pacote OPF, documentos de navegação e capítulos XHTML na memória.'],
    limits: ['Validation covers core container and reference integrity, not the complete EPUBCheck specification or every accessibility rule.', 'A validação cobre contêiner e referências essenciais, não toda a especificação EPUBCheck nem cada regra de acessibilidade.'],
    status: ['EPUB · ZIP/XML', 'EPUB · ZIP/XML'], schemaCategory: 'UtilitiesApplication'
  }],
  ['publishing-studio', {
    title: ['Markdown / LaTeX Publishing Studio', 'Estúdio de publicação Markdown / LaTeX'],
    subtitle: ['Write, preview, and export HTML or PDF', 'Escreva, visualize e exporte HTML ou PDF'],
    description: ['Author Markdown or lightweight LaTeX, preview sanitized HTML locally, and export self-contained HTML, a generated PDF, or a styled browser-print PDF.', 'Escreva Markdown ou LaTeX leve, visualize HTML sanitizado localmente e exporte HTML autocontido, um PDF gerado ou um PDF estilizado pela impressão do navegador.'],
    note: ['A deterministic parser renders the source into an isolated preview; the direct text-layout PDF is built locally with pdf-lib and the print path preserves the styled HTML preview.', 'Um parser determinístico renderiza a fonte em uma prévia isolada; o PDF direto com layout de texto é criado localmente com pdf-lib e a impressão preserva a prévia HTML estilizada.'],
    limits: ['The LaTeX path is a documented practical subset rather than a full TeX engine; direct PDF export is capped at 500,000 source characters and represents images by alt text, while styled image output uses browser print.', 'O caminho LaTeX é um subconjunto prático documentado, não um TeX completo; o PDF direto limita a fonte a 500.000 caracteres e representa imagens pelo texto alternativo, enquanto imagens estilizadas usam a impressão do navegador.'],
    status: ['Markdown · Math', 'Markdown · Matemática'], schemaCategory: 'UtilitiesApplication'
  }],
  ['archive-manager', {
    title: ['Archive Manager', 'Gerenciador de arquivos compactados'],
    subtitle: ['Inspect, extract, and create local archives', 'Inspecione, extraia e crie arquivos compactados'],
    description: ['Inspect and safely extract ZIP, TAR, GZIP, 7z, and XZ/LZMA-compressed TAR plus other libarchive-supported families, and create genuine ZIP, TAR, TAR.GZ, 7z, or TAR.XZ archives.', 'Inspecione e extraia com segurança ZIP, TAR, GZIP, 7z e TAR comprimido com XZ/LZMA, além de outras famílias aceitas pelo libarchive, e crie arquivos ZIP, TAR, TAR.GZ, 7z ou TAR.XZ reais.'],
    note: ['Tested ZIP/TAR/GZIP paths are complemented by lazy site-hosted libarchive and 7-Zip WASM runtimes; paths are normalized before both extraction and creation.', 'Caminhos testados de ZIP/TAR/GZIP são complementados por runtimes libarchive e 7-Zip WASM hospedados no site e carregados sob demanda; caminhos são normalizados antes de extrair e criar.'],
    limits: ['Encryption, links, devices, traversal, raw standalone XZ streams, oversized entries, and excessive expanded data are rejected.', 'Criptografia, links, dispositivos, travessia, fluxos XZ brutos isolados, entradas grandes demais e excesso de dados expandidos são recusados.'],
    status: ['ZIP · 7z · TAR.XZ', 'ZIP · 7z · TAR.XZ'], schemaCategory: 'UtilitiesApplication'
  }],
  ['file-inspector', {
    title: ['Universal File Inspector', 'Inspetor universal de arquivos'],
    subtitle: ['Hex, MIME, entropy, strings, and structure', 'Hex, MIME, entropia, strings e estrutura'],
    description: ['Inspect any local file through a capped hex view, magic-byte MIME detection, entropy map, extracted strings, hashes, and known binary structures.', 'Inspecione arquivos locais com visão hexadecimal limitada, detecção MIME por assinatura, mapa de entropia, strings, hashes e estruturas conhecidas.'],
    note: ['Only the ranges needed for each view are read; large files are sampled deterministically and the report states every sampling limit.', 'Somente intervalos necessários são lidos; arquivos grandes são amostrados deterministicamente e o relatório informa cada limite.'],
    limits: ['Binary structure parsing covers documented signatures and headers, not every proprietary format or evidence-grade forensics workflow.', 'A análise estrutural cobre assinaturas e cabeçalhos documentados, não todo formato proprietário nem perícia probatória.'],
    status: ['Bytes · Local', 'Bytes · Local'], schemaCategory: 'DeveloperApplication'
  }],
  ['file-deduplicator', {
    title: ['Local File Deduplicator', 'Deduplicador local de arquivos'],
    subtitle: ['Exact hashes and perceptual image similarity', 'Hashes exatos e semelhança perceptual'],
    description: ['Scan selected folders, group byte-identical files by SHA-256, find visually similar images with a perceptual hash, and export a review report.', 'Examine pastas selecionadas, agrupe arquivos idênticos por SHA-256, encontre imagens visualmente semelhantes e exporte um relatório.'],
    note: ['The scanner is report-only: it hashes locally, caps image decoding, and never deletes or moves user files.', 'O scanner apenas relata: calcula hashes localmente, limita a decodificação e nunca apaga nem move arquivos.'],
    limits: ['Perceptual similarity is a heuristic and must be reviewed; exact duplicate groups still may have different filenames or filesystem metadata.', 'Semelhança perceptual é heurística e exige revisão; duplicatas exatas ainda podem ter nomes ou metadados de sistema diferentes.'],
    status: ['SHA-256 · pHash', 'SHA-256 · pHash'], schemaCategory: 'UtilitiesApplication'
  }],
  ['encryption-vault', {
    title: ['Local Encryption Vault', 'Cofre de criptografia local'],
    subtitle: ['Password-based authenticated file encryption', 'Criptografia autenticada de arquivos por senha'],
    description: ['Encrypt one file or a ZIP-bundled selection/folder into a versioned authenticated container, then decrypt and verify it without exposing plaintext.', 'Criptografe um arquivo ou uma seleção/pasta empacotada em ZIP em um contêiner autenticado e versionado, depois descriptografe e verifique sem expor o conteúdo.'],
    note: ['PBKDF2 derives an AES-GCM key with a random salt and nonce for every container; the authenticated header records the format version.', 'PBKDF2 deriva uma chave AES-GCM com salt e nonce aleatórios para cada contêiner; o cabeçalho autenticado registra a versão.'],
    limits: ['Losing the password makes recovery impossible; this non-streaming browser build enforces a strict aggregate size cap and does not replace backups.', 'Perder a senha torna a recuperação impossível; esta versão sem streaming impõe limite estrito de tamanho e não substitui backups.'],
    status: ['AES-GCM · PBKDF2', 'AES-GCM · PBKDF2'], schemaCategory: 'SecurityApplication'
  }],
  ['sqlite-workbench', {
    title: ['SQLite Workbench', 'Bancada SQLite'],
    subtitle: ['Inspect schemas and query local databases', 'Inspecione esquemas e consulte bancos locais'],
    description: ['Open a SQLite database, validate its header and pages, inspect schema records, run supported local queries, edit rows when the runtime permits, and export a copy.', 'Abra um banco SQLite, valide cabeçalho e páginas, inspecione registros de esquema, execute consultas locais compatíveis, edite linhas quando possível e exporte uma cópia.'],
    note: ['Database bytes remain local; the workbench distinguishes structural inspection from operations that require a SQLite WASM runtime.', 'Os bytes permanecem locais; a bancada distingue inspeção estrutural de operações que exigem runtime SQLite WASM.'],
    limits: ['WAL companions, extensions, encrypted databases, virtual tables, and very large files may require a full desktop SQLite environment.', 'Arquivos WAL, extensões, bancos criptografados, tabelas virtuais e arquivos muito grandes podem exigir SQLite desktop.'],
    status: ['SQLite · Local', 'SQLite · Local'], schemaCategory: 'DeveloperApplication'
  }],
  ['duckdb-studio', {
    title: ['DuckDB Data Studio', 'Estúdio de dados DuckDB'],
    subtitle: ['Query CSV, JSON, and Parquet locally', 'Consulte CSV, JSON e Parquet localmente'],
    description: ['Load local CSV, newline JSON, JSON, and supported Parquet data, inspect columns, run analytical queries, and export result tables.', 'Carregue CSV, JSON em linhas, JSON e Parquet compatível, inspecione colunas, execute consultas analíticas e exporte tabelas.'],
    note: ['A query adapter runs locally and reports whether the lightweight table engine or an available DuckDB WASM runtime handled the request.', 'Um adaptador de consultas roda localmente e informa se o mecanismo leve ou DuckDB WASM disponível executou a solicitação.'],
    limits: ['The built-in fallback supports a documented SELECT/filter/group/order subset; Parquet and full SQL require the optional DuckDB runtime.', 'O fallback aceita um subconjunto documentado de SELECT, filtro, grupo e ordenação; Parquet e SQL completo exigem DuckDB opcional.'],
    status: ['Local SQL', 'SQL local'], schemaCategory: 'DeveloperApplication'
  }],
  ['data-converter', {
    title: ['Parquet / CSV / JSON Converter', 'Conversor Parquet / CSV / JSON'],
    subtitle: ['Convert, filter, join, and aggregate data', 'Converta, filtre, junte e agregue dados'],
    description: ['Convert supported local tabular files, select and filter columns, join two datasets, aggregate groups, and export CSV or JSON.', 'Converta arquivos tabulares locais compatíveis, selecione e filtre colunas, una dois datasets, agregue grupos e exporte CSV ou JSON.'],
    note: ['Rows are normalized to typed records, transformed through explicit operations, and serialized only after a preview.', 'Linhas são normalizadas em registros tipados, transformadas por operações explícitas e serializadas somente após prévia.'],
    limits: ['The in-memory path is capped; very large or Parquet workloads require the optional DuckDB/Arrow runtime and sufficient device memory.', 'O caminho em memória é limitado; cargas muito grandes ou Parquet exigem DuckDB/Arrow opcional e memória suficiente.'],
    status: ['Tabular · Local', 'Tabular · Local'], schemaCategory: 'DeveloperApplication'
  }],
  ['bi-dashboard', {
    title: ['Local BI Dashboard', 'Dashboard local de BI'],
    subtitle: ['Safe SQL, charts, pivots, and filters', 'SQL seguro, gráficos, pivôs e filtros'],
    description: ['Drop in a local dataset, infer fields, apply a bounded SQL subset and filters, build pivots and accessible charts, and export a self-contained report.', 'Carregue um dataset local, infira campos, aplique SQL limitado e filtros, crie pivôs e gráficos acessíveis e exporte um relatório autocontido.'],
    note: ['Aggregations run on local typed rows and every chart has a matching data table for accessible review.', 'Agregações rodam em linhas tipadas localmente e todo gráfico possui tabela correspondente para revisão acessível.'],
    limits: ['Dashboard state remains in this tab unless exported; high-cardinality fields and very large inputs are sampled or rejected with disclosure.', 'O estado fica nesta aba salvo quando exportado; campos de alta cardinalidade e entradas enormes são amostrados ou rejeitados com aviso.'],
    status: ['Charts · Pivots', 'Gráficos · Pivôs'], schemaCategory: 'DeveloperApplication'
  }],
  ['data-notebook', {
    title: ['Jupyter-like Data Notebook', 'Notebook de dados estilo Jupyter'],
    subtitle: ['Ordered local code and data cells', 'Células locais de código e dados'],
    description: ['Create ordered Markdown and code cells, run the safe built-in data language immediately, and use local Python when a Pyodide runtime is available.', 'Crie células Markdown e código, execute a linguagem segura de dados e use Python local quando Pyodide estiver disponível.'],
    note: ['Cell outputs and dependencies are explicit; notebook JSON can be exported and imported without sending code anywhere.', 'Saídas e dependências das células são explícitas; o JSON do notebook pode ser exportado e importado sem enviar código.'],
    limits: ['The built-in evaluator is intentionally constrained and not JavaScript eval; full Python packages require the optional, disclosed Pyodide download.', 'O avaliador interno é intencionalmente restrito e não usa eval JavaScript; Python completo exige download opcional e informado do Pyodide.'],
    status: ['Notebook · Local', 'Notebook · Local'], schemaCategory: 'DeveloperApplication'
  }],
  ['regex-workbench', {
    title: ['Regex / Data Extraction Workbench', 'Bancada de regex e extração'],
    subtitle: ['Timed matches, captures, and exports', 'Correspondências, grupos e exportações cronometrados'],
    description: ['Test JavaScript regular expressions against pasted text or bounded local files, inspect exact offsets and captures, and export retained matches.', 'Teste expressões regulares JavaScript em texto ou arquivos locais limitados, inspecione offsets exatos e grupos e exporte correspondências retidas.'],
    note: ['Whole UTF-8 inputs up to 64 MiB run in a disposable worker, preserving arbitrary cross-line matches while retaining at most 10,000 results.', 'Entradas UTF-8 integrais de até 64 MiB rodam em worker descartável, preservando matches arbitrários entre linhas e retendo no máximo 10.000 resultados.'],
    limits: ['The dialect is modern JavaScript RegExp; the worker is forcibly terminated after its wall-time budget to contain catastrophic patterns.', 'O dialeto é RegExp JavaScript moderno; o worker é encerrado à força após o limite de tempo para conter padrões catastróficos.'],
    status: ['Timed regex worker', 'Worker regex cronometrado'], schemaCategory: 'DeveloperApplication'
  }],
  ['git-client', {
    title: ['Git Client', 'Cliente Git'],
    subtitle: ['Inspect local repositories, diffs, and history', 'Inspecione repositórios, diffs e histórico'],
    description: ['Open a selected local Git working tree, inspect status, refs and history, compare bounded UTF-8 files, and stage all changes into a real commit in a private virtual copy.', 'Abra uma árvore Git local selecionada, inspecione status, refs e histórico, compare arquivos UTF-8 limitados e prepare todas as mudanças em um commit real numa cópia virtual privada.'],
    note: ['isomorphic-git resolves loose and packed objects and writes new virtual objects/refs only in page memory; it never modifies the selected folder or contacts a remote.', 'isomorphic-git resolve objetos soltos e compactados e grava novos objetos/refs virtuais apenas na memória da página; nunca altera a pasta selecionada nem contata remotos.'],
    limits: ['Virtual commits vanish when the page closes; the downloadable report records metadata but is not a repository backup. Fetch/push, merges, signing, and writing back to the selected folder are unavailable.', 'Commits virtuais desaparecem ao fechar a página; o relatório baixável registra metadados, mas não é um backup do repositório. Fetch/push, merges, assinatura e gravação na pasta selecionada não estão disponíveis.'],
    status: ['Git · Offline', 'Git · Offline'], schemaCategory: 'DeveloperApplication'
  }],
  ['binary-diff', {
    title: ['Binary Diff Tool', 'Ferramenta de diff binário'],
    subtitle: ['Byte ranges, patches, entropy, and structure', 'Intervalos, patches, entropia e estrutura'],
    description: ['Compare two binaries, group changed ranges, map entropy, inspect known headers, create a compact verified patch, and apply it locally.', 'Compare dois binários, agrupe intervalos alterados, mapeie entropia, inspecione cabeçalhos, crie um patch verificado e aplique localmente.'],
    note: ['The patch records source and target SHA-256 digests and only changed ranges; application verifies both ends.', 'O patch registra SHA-256 de origem e destino e apenas intervalos alterados; a aplicação verifica ambos.'],
    limits: ['The patch format is specific to this tool and does not relocate structured records or replace semantic format-aware diffing.', 'O formato de patch é específico e não realoca registros estruturados nem substitui diff semântico por formato.'],
    status: ['Byte patch', 'Patch de bytes'], schemaCategory: 'DeveloperApplication'
  }],
  ['code-playground', {
    title: ['Code Playground / Compiler', 'Playground de código / compilador'],
    subtitle: ['Edit, validate, run, and inspect local code', 'Edite, valide, execute e inspecione código'],
    description: ['Run isolated JavaScript and web sandboxes, validate JSON and WebAssembly modules, compile C/C++ with Clang, and compile/run Rust against a local WASI sysroot.', 'Execute sandboxes isolados de JavaScript e web, valide JSON e módulos WebAssembly, compile C/C++ com Clang e compile/execute Rust com um sysroot WASI local.'],
    note: ['C/C++ uses the site-hosted Emception toolchain; Rust uses a site-hosted Rubrc/rustc worker whose compressed compiler and sysroot are cached locally after an explicit first load.', 'C/C++ usa o toolchain Emception hospedado no site; Rust usa um worker Rubrc/rustc hospedado no site cujo compilador compactado e sysroot ficam em cache após a primeira carga explícita.'],
    limits: ['Native toolchains are large and require cross-origin isolation; the Rust workspace targets wasm32-wasip1, has no external crate downloads, and inherits the disclosed limitations of the pre-release Rubrc runtime.', 'Toolchains nativos são grandes e exigem isolamento entre origens; o workspace Rust usa o alvo wasm32-wasip1, não baixa crates externas e herda as limitações informadas do runtime Rubrc em pré-lançamento.'],
    status: ['Sandboxed worker', 'Worker isolado'], schemaCategory: 'DeveloperApplication'
  }],
  ['packet-analyzer', {
    title: ['Network Packet Analyzer', 'Analisador de pacotes de rede'],
    subtitle: ['Offline PCAP and PCAPNG inspection', 'Inspeção offline de PCAP e PCAPNG'],
    description: ['Open PCAP or PCAPNG captures, inspect Ethernet, IPv4, IPv6, TCP, UDP, ICMP and basic DNS fields, filter packets, and export a summary.', 'Abra capturas PCAP ou PCAPNG, inspecione Ethernet, IPv4, IPv6, TCP, UDP, ICMP e DNS básico, filtre pacotes e exporte um resumo.'],
    note: ['A bounded parser reads capture records and protocol headers locally; packet payloads are not uploaded or executed.', 'Um parser limitado lê registros e cabeçalhos localmente; payloads não são enviados nem executados.'],
    limits: ['Reassembly, decryption, checksum validation, every link type, every PCAPNG block type, and Wireshark-level dissectors are outside this parser.', 'Remontagem, descriptografia, validação de checksums, todo link type, todo tipo de bloco PCAPNG e dissectors no nível do Wireshark ficam fora deste parser.'],
    status: ['PCAP · Offline', 'PCAP · Offline'], schemaCategory: 'DeveloperApplication'
  }],
  ['local-search', {
    title: ['Local Search Engine', 'Mecanismo de busca local'],
    subtitle: ['Index folders and search full text', 'Indexe pastas e pesquise texto completo'],
    description: ['Index selected text, Markdown, JSON, CSV, HTML, and subtitle files, search phrases and terms, rank results, preview context, and export the index.', 'Indexe arquivos de texto, Markdown, JSON, CSV, HTML e legendas, pesquise frases e termos, ordene resultados, veja contexto e exporte o índice.'],
    note: ['A compact inverted index with field lengths and term frequencies lives only in memory unless you explicitly export it.', 'Um índice invertido compacto com frequências e tamanhos vive somente na memória salvo quando exportado.'],
    limits: ['Binary office and PDF text extraction is not automatic here; indexing is capped and uses simple Unicode tokenization rather than language-specific stemming.', 'A extração de Office e PDF não é automática aqui; a indexação é limitada e usa tokenização Unicode simples sem stemming por idioma.'],
    status: ['Inverted index', 'Índice invertido'], schemaCategory: 'UtilitiesApplication'
  }],
  ['model-viewer', {
    title: ['3D Model Viewer', 'Visualizador de modelos 3D'],
    subtitle: ['Inspect STL, OBJ, PLY, and glTF geometry', 'Inspecione geometria STL, OBJ, PLY e glTF'],
    description: ['Open common mesh files, orbit a local 3D preview, inspect bounds and topology, measure points, toggle sections and wireframes, and export a report.', 'Abra malhas comuns, orbite uma prévia 3D local, inspecione limites e topologia, meça pontos, alterne seções e wireframe e exporte um relatório.'],
    note: ['Format parsers normalize geometry into capped vertex and triangle buffers rendered on a local canvas.', 'Parsers normalizam a geometria em buffers limitados de vértices e triângulos renderizados localmente.'],
    limits: ['Material, texture, animation, skinning, compression extension, and unit support varies by format and is reported before rendering.', 'Suporte a materiais, texturas, animação, skinning, extensões e unidades varia por formato e é informado antes da renderização.'],
    status: ['Mesh · Local', 'Malha · Local'], schemaCategory: 'DesignApplication'
  }],
  ['model-converter', {
    title: ['3D Model Converter', 'Conversor de modelos 3D'],
    subtitle: ['Convert STL, OBJ, PLY, and glTF meshes', 'Converta malhas STL, OBJ, PLY e glTF'],
    description: ['Parse supported meshes, repair basic indices and normals, scale or center geometry, reduce duplicate vertices, and export STL, OBJ, PLY, or embedded glTF.', 'Interprete malhas compatíveis, corrija índices e normais básicos, escale ou centralize, reduza vértices duplicados e exporte STL, OBJ, PLY ou glTF incorporado.'],
    note: ['Conversion passes through one explicit triangle-mesh representation and reports every attribute that cannot survive the target format.', 'A conversão passa por uma representação explícita de triângulos e informa cada atributo incompatível com o destino.'],
    limits: ['Conversion may lose materials, textures, hierarchy, animation, units, and non-triangle primitives; glTF export is geometry-focused.', 'A conversão pode perder materiais, texturas, hierarquia, animação, unidades e primitivas não triangulares; glTF é focado em geometria.'],
    status: ['Mesh conversion', 'Conversão de malha'], schemaCategory: 'DesignApplication'
  }],
  ['cad-lite', {
    title: ['CAD-lite', 'CAD-lite'],
    subtitle: ['Parametric sketches and extrusion', 'Esboços paramétricos e extrusão'],
    description: ['Create dimensioned rectangles, circles and polygons, apply practical constraints, extrude profiles, combine simple solids, and export STL.', 'Crie retângulos, círculos e polígonos cotados, aplique restrições práticas, extrude perfis, combine sólidos simples e exporte STL.'],
    note: ['A deterministic parametric model regenerates mesh geometry from editable dimensions and a saved JSON design tree.', 'Um modelo paramétrico determinístico regenera a malha a partir de dimensões editáveis e uma árvore JSON.'],
    limits: ['Booleans are limited to supported primitive combinations; this is not a precision B-rep kernel and dimensions must be verified before fabrication.', 'Booleanas se limitam a combinações compatíveis; não é um kernel B-rep de precisão e dimensões devem ser verificadas antes de fabricar.'],
    status: ['Parametric mesh', 'Malha paramétrica'], schemaCategory: 'DesignApplication'
  }],
  ['mesh-editor', {
    title: ['Blender-lite Mesh Editor', 'Editor de malha Blender-lite'],
    subtitle: ['Edit vertices, faces, UVs, and modifiers', 'Edite vértices, faces, UVs e modificadores'],
    description: ['Load a mesh, select and transform vertices, edges, or faces, recalculate normals, apply mirror and subdivision-style modifiers, edit basic UVs, and export.', 'Carregue uma malha, selecione e transforme vértices, arestas ou faces, recalcule normais, aplique espelho e subdivisão, edite UVs básicos e exporte.'],
    note: ['Every edit updates a capped in-memory mesh and an undoable command log before local export.', 'Cada edição atualiza uma malha limitada e um log de comandos com desfazer antes da exportação local.'],
    limits: ['Sculpting is a local falloff transform, modifiers are destructive on apply, and the editor does not support rigs, materials, or production Blender files.', 'Escultura é uma transformação local por influência, modificadores são destrutivos ao aplicar e não há suporte a rigs, materiais nem arquivos Blender.'],
    status: ['Mesh editing', 'Edição de malha'], schemaCategory: 'DesignApplication'
  }],
  ['slicer', {
    title: ['3D Printing Slicer', 'Fatiador para impressão 3D'],
    subtitle: ['Slice STL, preview layers, and export G-code', 'Fatie STL, visualize camadas e exporte G-code'],
    description: ['Slice a validated STL into layers, configure nozzle, layer height, temperatures, walls and grid infill, preview paths, and export reviewable G-code.', 'Fatie um STL validado em camadas, configure bico, altura, temperaturas, paredes e infill em grade, visualize trajetórias e exporte G-code revisável.'],
    note: ['Triangle-plane intersections form layer segments; a deterministic planner emits bounded perimeters, infill, travel, and extrusion commands.', 'Interseções triângulo-plano formam segmentos; um planejador determinístico emite perímetros, infill, viagens e extrusão.'],
    limits: ['Generated G-code is experimental, profile-generic, and must be simulated and reviewed for your exact printer, firmware, material, and safety limits.', 'O G-code é experimental e genérico; deve ser simulado e revisado para sua impressora, firmware, material e segurança.'],
    status: ['STL · G-code', 'STL · G-code'], schemaCategory: 'DesignApplication'
  }],
  ['gerber-viewer', {
    title: ['PCB / Gerber Viewer', 'Visualizador de PCB / Gerber'],
    subtitle: ['Inspect Gerber and Excellon layers', 'Inspecione camadas Gerber e Excellon'],
    description: ['Load Gerber and Excellon fabrication files, assign copper, mask, silk and drill layers, render them locally, measure features, and export a report.', 'Carregue arquivos Gerber e Excellon, atribua cobre, máscara, silk e furação, renderize localmente, meça recursos e exporte relatório.'],
    note: ['A bounded RS-274X and Excellon parser resolves units, coordinates, apertures, flashes, segments and drill hits into a canvas scene.', 'Um parser limitado RS-274X e Excellon resolve unidades, coordenadas, aberturas, flashes, segmentos e furos em canvas.'],
    limits: ['Complex macros, step-repeat, regions, polarity combinations, attributes, and uncommon dialects may be incomplete and are reported.', 'Macros complexas, step-repeat, regiões, combinações de polaridade, atributos e dialetos incomuns podem ficar incompletos e são informados.'],
    status: ['Gerber · Excellon', 'Gerber · Excellon'], schemaCategory: 'DesignApplication'
  }],
  ['llm-playground', {
    title: ['Local LLM Playground', 'Playground local de LLM'],
    subtitle: ['Inspect models and run local generation', 'Inspecione modelos e gere localmente'],
    description: ['Inspect GGUF metadata, estimate device memory, configure prompts and sampling, and run compatible local inference when a disclosed model runtime is available.', 'Inspecione metadados GGUF, estime memória, configure prompts e amostragem e rode inferência local compatível quando houver runtime informado.'],
    note: ['Model files stay on this device; metadata inspection works immediately and inference begins only after runtime compatibility and memory checks.', 'Modelos ficam no dispositivo; a inspeção funciona imediatamente e a inferência começa somente após checagens de runtime e memória.'],
    limits: ['GGUF versions, architectures, quantizations, chat templates, context limits, and WebGPU memory vary; unsupported inference is never simulated.', 'Versões GGUF, arquiteturas, quantizações, templates, contexto e memória WebGPU variam; inferência incompatível nunca é simulada.'],
    status: ['GGUF · Local AI', 'GGUF · IA local'], privacy: MODEL_PRIVACY, schemaCategory: 'DeveloperApplication'
  }],
  ['speech-to-text', {
    title: ['Local Speech-to-Text', 'Transcrição local de fala'],
    subtitle: ['Audio or video to reviewed transcript', 'Áudio ou vídeo para transcrição revisada'],
    description: ['Decode local audio or video, run on-device Whisper transcription with timestamps, review segments, and export TXT, VTT, SRT, or JSON.', 'Decodifique áudio ou vídeo local, transcreva com Whisper no dispositivo e timestamps, revise segmentos e exporte TXT, VTT, SRT ou JSON.'],
    note: ['The established local transcription runtime is reused after explicit model download disclosure; media bytes are never uploaded.', 'O runtime de transcrição local já estabelecido é reutilizado após informar o download do modelo; a mídia nunca é enviada.'],
    limits: ['Input duration and memory are capped; accuracy varies with language, speakers, noise, codec support, and model size, so review is required.', 'Duração e memória são limitadas; a precisão varia com idioma, falantes, ruído, codec e modelo, exigindo revisão.'],
    status: ['On-device Whisper', 'Whisper no dispositivo'], privacy: MODEL_PRIVACY, schemaCategory: 'MultimediaApplication'
  }],
  ['vision-lab', {
    title: ['Local Computer Vision Lab', 'Laboratório local de visão computacional'],
    subtitle: ['Preprocess images and run ONNX vision models', 'Pré-processe imagens e rode modelos ONNX'],
    description: ['Load an ONNX vision model, configure image preprocessing and output adapters, run classification, detection or segmentation locally, and export results.', 'Carregue um modelo ONNX de visão, configure pré-processamento e adaptadores, rode classificação, detecção ou segmentação localmente e exporte resultados.'],
    note: ['The local ONNX runtime receives a tensor built from the previewed resize, color order, normalization, and layout settings.', 'O runtime ONNX local recebe um tensor criado a partir de resize, ordem de cores, normalização e layout visualizados.'],
    limits: ['Arbitrary model outputs need an explicit adapter; the generic view exposes tensors rather than guessing labels, boxes, or masks.', 'Saídas arbitrárias exigem adaptador explícito; a visão genérica mostra tensores sem adivinhar rótulos, caixas ou máscaras.'],
    status: ['ONNX · WebGPU', 'ONNX · WebGPU'], privacy: MODEL_PRIVACY, schemaCategory: 'DeveloperApplication'
  }],
  ['ai-media-studio', {
    title: ['Local AI Media Studio', 'Estúdio local de mídia com IA'],
    subtitle: ['OCR, vision, transcription, embeddings, and search', 'OCR, visão, transcrição, embeddings e busca'],
    description: ['Build a private media project with image OCR and ONNX classification, audio transcription, MiniLM embeddings, and local semantic search across derived records.', 'Crie um projeto privado com OCR e classificação ONNX de imagens, transcrição de áudio, embeddings MiniLM e busca semântica local nos registros derivados.'],
    note: ['The studio orchestrates disclosed local model tasks and stores normalized text, timing, provenance, and vectors only in the current tab unless exported.', 'O estúdio orquestra tarefas locais informadas e guarda texto, tempos, proveniência e vetores somente nesta aba salvo quando exportado.'],
    limits: ['OCR, transcription and embedding models depend on device support and optional downloads; ONNX image classification needs user-supplied preprocessing and labels; exported indexes contain derived sensitive text.', 'OCR, transcrição e embeddings dependem do dispositivo e downloads opcionais; classificação ONNX exige pré-processamento e rótulos informados; índices exportados contêm texto sensível derivado.'],
    status: ['Private AI workspace', 'Workspace privado de IA'], privacy: MODEL_PRIVACY, schemaCategory: 'MultimediaApplication'
  }]
];

export const suiteTools = entries.map(([key, fields], offset) => define(offset + 14, key, fields));
