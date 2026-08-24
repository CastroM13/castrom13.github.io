import { suiteTools } from './suite-tool-data.mjs';

export const originalTools = [
  {
    index: '01',
    schemaCategory: 'UtilitiesApplication',
    status: { en: 'Available', pt: 'Disponível' },
    title: { en: 'QR Code Studio', pt: 'Estúdio de QR Code' },
    description: {
      en: 'Generate and customize QR codes directly in the browser.',
      pt: 'Gere e personalize QR codes diretamente no navegador.'
    },
    paths: { en: '/qrcode/', pt: '/pt-br/ferramentas/qrcode/' }
  },
  {
    index: '02',
    schemaCategory: 'UtilitiesApplication',
    status: { en: 'Local only', pt: 'Somente local' },
    title: { en: 'Password & Passphrase', pt: 'Senhas e frases-senha' },
    description: {
      en: 'Generate credentials with Web Crypto and a clear estimate of the search space.',
      pt: 'Gere credenciais com Web Crypto e uma estimativa clara do espaço de busca.'
    },
    paths: { en: '/tools/password/', pt: '/pt-br/ferramentas/senhas/' }
  },
  {
    index: '03',
    schemaCategory: 'UtilitiesApplication',
    status: { en: 'WCAG 2.2', pt: 'WCAG 2.2' },
    title: { en: 'Contrast Workbench', pt: 'Bancada de contraste' },
    description: {
      en: 'Test text and UI contrast, preview the pair, and find a nearby passing foreground.',
      pt: 'Teste contraste, visualize o par e encontre uma cor próxima que atenda ao critério.'
    },
    paths: { en: '/tools/contrast/', pt: '/pt-br/ferramentas/contraste/' }
  }
];

export const newTools = [
  {
    key: 'tokendesk', index: '04', status: { en: 'Web Crypto', pt: 'Web Crypto' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'TokenDesk', pt: 'TokenDesk' },
    subtitle: { en: 'Private JWT / JWK inspector', pt: 'Inspetor privado de JWT / JWK' },
    description: {
      en: 'Decode JWTs, inspect time claims, flag risky algorithms, and optionally verify a signature with a JWK—without sending the token anywhere.',
      pt: 'Decodifique JWTs, inspecione claims temporais, sinalize algoritmos de risco e, opcionalmente, verifique uma assinatura com uma JWK — sem enviar o token.'
    },
    privacy: { en: 'Token and key stay in this tab · Nothing is stored', pt: 'Token e chave ficam nesta aba · Nada é armazenado' },
    paths: { en: '/tools/tokendesk/', pt: '/pt-br/ferramentas/tokendesk/' },
    note: {
      en: 'Decoding is not verification. TokenDesk shows that distinction throughout the result, uses Web Crypto when a compatible JWK is supplied, and exports only allowlisted metadata—never decoded claim values.',
      pt: 'Decodificar não é verificar. O TokenDesk mantém essa distinção no resultado, usa Web Crypto quando uma JWK compatível é fornecida e exporta apenas metadados permitidos — nunca os valores decodificados dos claims.'
    },
    limits: {
      en: 'Designed for inspection, incident response, and debugging—not as an authorization decision engine.',
      pt: 'Feito para inspeção, resposta a incidentes e depuração — não para tomar decisões de autorização.'
    }
  },
  {
    key: 'media-cleaner', index: '05', status: { en: 'Local processing', pt: 'Processamento local' },
    schemaCategory: 'MultimediaApplication',
    title: { en: 'Image Metadata Cleaner', pt: 'Removedor de metadados de imagens' },
    subtitle: { en: 'Inspect, resize, and re-encode images', pt: 'Inspeção, redimensionamento e recodificação' },
    description: {
      en: 'Inspect recognized JPEG, PNG, and WebP metadata, create a fresh canvas re-encode, resize images, and convert formats without uploading the originals.',
      pt: 'Inspecione metadados reconhecidos de JPEG, PNG e WebP, gere uma nova codificação via canvas, redimensione e converta imagens sem enviar os originais.'
    },
    privacy: { en: 'Images are decoded and exported on this device', pt: 'As imagens são decodificadas e exportadas neste dispositivo' },
    paths: { en: '/tools/media-cleaner/', pt: '/pt-br/ferramentas/limpeza-de-midia/' },
    note: {
      en: 'The output is a newly encoded image. The report compares recognized source metadata and byte size with the exported file.',
      pt: 'A saída é uma imagem recodificada. O relatório compara os metadados reconhecidos e o tamanho do original com o arquivo exportado.'
    },
    limits: {
      en: 'The report recognizes a defined set of common metadata, not every type of metadata or steganographic channel. Animated images are flattened to one frame, and color profiles may change.',
      pt: 'O relatório reconhece um conjunto definido de metadados comuns, não todos os tipos de metadados nem canais esteganográficos. Imagens animadas são reduzidas a um quadro, e perfis de cor podem mudar.'
    }
  },
  {
    key: 'harsafe', index: '06', status: { en: 'Sanitized export', pt: 'Exportação sanitizada' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'HARsafe', pt: 'HARsafe' },
    subtitle: { en: 'Network trace analyzer and sanitizer', pt: 'Analisador e sanitizador de capturas de rede' },
    description: {
      en: 'Summarize a HAR, report applied redaction categories, redact headers, cookies, query values, and bodies, then export a safer trace.',
      pt: 'Resuma um HAR, informe as categorias de ocultação aplicadas, remova dados de cabeçalhos, cookies, parâmetros de consulta e corpos e exporte uma captura mais segura.'
    },
    privacy: { en: 'HAR contents never leave the browser', pt: 'O conteúdo do HAR nunca sai do navegador' },
    paths: { en: '/tools/harsafe/', pt: '/pt-br/ferramentas/harsafe/' },
    note: {
      en: 'The original object is never modified. HARsafe builds a cloned export and reports every redaction category it applied.',
      pt: 'O objeto original não é alterado. O HARsafe cria uma cópia e informa cada categoria de ocultação aplicada.'
    },
    limits: {
      en: 'Automated redaction cannot prove that a trace is safe. Review the exported file before sharing it.',
      pt: 'A ocultação automática não prova que uma captura é segura. Revise o arquivo exportado antes de compartilhá-lo.'
    }
  },
  {
    key: 'logglass', index: '07', status: { en: 'Local stream', pt: 'Fluxo local' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'LogGlass', pt: 'LogGlass' },
    subtitle: { en: 'Large local log explorer', pt: 'Explorador local de logs grandes' },
    description: {
      en: 'Stream text or JSONL logs in a dedicated worker, filter without reading the whole file into memory, summarize levels, and export a selection with best-effort redaction.',
      pt: 'Processe logs de texto ou JSONL em um Web Worker dedicado, filtre sem carregar o arquivo inteiro na memória, resuma por nível e exporte uma seleção com ocultação por melhor esforço.'
    },
    privacy: { en: 'Files are streamed locally · No telemetry', pt: 'Arquivos processados localmente · Sem telemetria' },
    paths: { en: '/tools/logglass/', pt: '/pt-br/ferramentas/logglass/' },
    note: {
      en: 'Only a capped window of matching lines is retained for display. Counts continue across the complete stream.',
      pt: 'Apenas uma janela limitada de linhas correspondentes fica na tela. As contagens cobrem o fluxo completo.'
    },
    limits: {
      en: 'Log formats are inferred conservatively, and automated redaction cannot prove an export is safe. Review it before sharing.',
      pt: 'Os formatos são inferidos de forma conservadora, e a ocultação automática não prova que uma exportação é segura. Revise-a antes de compartilhar.'
    }
  },
  {
    key: 'edgebench', index: '08', status: { en: 'ONNX · WebGPU', pt: 'ONNX · WebGPU' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'EdgeBench', pt: 'EdgeBench' },
    subtitle: { en: 'ONNX browser benchmark', pt: 'Benchmark de ONNX no navegador' },
    description: {
      en: 'Run a local ONNX model with generated or JSON tensor inputs using WebGPU or WASM, then report p50, p95, sequential throughput, and a memory lower bound after explicit warm-up.',
      pt: 'Execute um modelo ONNX local com tensores gerados ou JSON usando WebGPU ou WASM e, após aquecimento explícito, veja p50, p95, vazão sequencial e um limite inferior de memória.'
    },
    privacy: { en: 'Model and samples stay local · Runtime loads on demand', pt: 'Modelo e amostras permanecem no dispositivo · Runtime carregado sob demanda' },
    paths: { en: '/tools/edgebench/', pt: '/pt-br/ferramentas/edgebench/' },
    note: {
      en: 'The benchmark records wall-clock inference time after explicit warm-up. Raw timings and environment details can be exported as JSON.',
      pt: 'O benchmark mede o tempo de inferência após aquecimento explícito. Tempos brutos e ambiente podem ser exportados em JSON.'
    },
    limits: {
      en: 'Browser timing is affected by power mode, thermal throttling, other tabs, model operators, and backend support. Results are not cross-device guarantees.',
      pt: 'Os tempos variam com o modo de energia, limitação térmica, outras abas, operadores do modelo e suporte do backend. Os resultados não garantem desempenho em outros dispositivos.'
    }
  },
  {
    key: 'dataset-clinic', index: '09', status: { en: 'YOLO · COCO', pt: 'YOLO · COCO' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'Dataset Clinic', pt: 'Clínica de datasets' },
    subtitle: { en: 'Computer-vision dataset QA', pt: 'QA de datasets de visão computacional' },
    description: {
      en: 'Audit local YOLO folders or COCO JSON for missing labels, invalid boxes, class distribution, byte-identical duplicates, and exact-duplicate leakage between named splits.',
      pt: 'Audite pastas YOLO ou JSON COCO para encontrar rótulos ausentes, caixas inválidas, distribuição de classes, duplicatas idênticas em bytes e vazamento dessas duplicatas entre partições nomeadas.'
    },
    privacy: { en: 'Dataset files are inspected only on this device', pt: 'Os arquivos do dataset são inspecionados somente neste dispositivo' },
    paths: { en: '/tools/dataset-clinic/', pt: '/pt-br/ferramentas/clinica-de-datasets/' },
    note: {
      en: 'The clinic reports evidence, paths, and counts without rendering private images. Duplicate checks use local SHA-256 hashes.',
      pt: 'A clínica relata evidências, caminhos e contagens sem exibir imagens privadas. Duplicatas usam hashes SHA-256 locais.'
    },
    limits: {
      en: 'Class-balance warnings use a fixed 1% heuristic. Structural checks cannot determine whether an annotation is semantically correct.',
      pt: 'Os avisos de equilíbrio de classes usam uma heurística fixa de 1%. Verificações estruturais não determinam se uma anotação está semanticamente correta.'
    }
  },
  {
    key: 'statescope', index: '10', status: { en: 'Terraform', pt: 'Terraform' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'StateScope', pt: 'StateScope' },
    subtitle: { en: 'Terraform state explorer', pt: 'Explorador de state do Terraform' },
    description: {
      en: 'Inventory resources, providers, modules, dependencies, and cost-relevant infrastructure in a local Terraform state, then export a normalized report with optional identifier pseudonyms.',
      pt: 'Inventarie recursos, provedores, módulos, dependências e itens com possível impacto em custos em um state local e exporte um relatório normalizado com pseudônimos opcionais para os identificadores.'
    },
    privacy: { en: 'State remains local · Attribute values are never displayed', pt: 'O state permanece no dispositivo · Valores de atributos nunca são exibidos' },
    paths: { en: '/tools/statescope/', pt: '/pt-br/ferramentas/statescope/' },
    note: {
      en: 'StateScope inventories structure without exporting attribute values. The normalized report can pseudonymize resource, module, output, and dependency identifiers.',
      pt: 'O StateScope inventaria a estrutura sem exportar valores de atributos. O relatório normalizado pode usar pseudônimos para identificadores de recursos, módulos, saídas e dependências.'
    },
    limits: {
      en: 'The cost view identifies resource types that often affect spend; it does not calculate a cloud bill or replace a provider pricing calculator.',
      pt: 'A visão de custos identifica tipos de recurso que costumam afetar gastos; ela não calcula a fatura da nuvem nem substitui a calculadora de preços do provedor.'
    }
  },
  {
    key: 'secretsweep', index: '11', status: { en: 'No persistence', pt: 'Sem persistência' },
    schemaCategory: 'DeveloperApplication',
    title: { en: 'SecretSweep', pt: 'SecretSweep' },
    subtitle: { en: 'Local exposure scanner', pt: 'Detector local de exposição de segredos' },
    description: {
      en: 'Scan pasted text or selected files for credential patterns and high-entropy values, then export a redacted remediation report.',
      pt: 'Procure padrões de credenciais e valores de alta entropia em texto ou arquivos locais e exporte um relatório de correção sem valores brutos.'
    },
    privacy: { en: 'Inputs are never persisted, uploaded, or placed in URLs', pt: 'Entradas nunca são persistidas, enviadas ou colocadas em URLs' },
    paths: { en: '/tools/secretsweep/', pt: '/pt-br/ferramentas/secretsweep/' },
    note: {
      en: 'Matches are masked by default and include confidence, location, rationale, and provider-specific next steps where known.',
      pt: 'As correspondências são ocultadas por padrão e incluem nível de confiança, localização, motivo e, quando conhecidos, próximos passos específicos para o provedor.'
    },
    limits: {
      en: 'Pattern and entropy scanning produces false positives and cannot prove the absence of secrets. Rotate confirmed credentials immediately.',
      pt: 'A busca por padrões e entropia pode gerar falsos positivos e não prova a ausência de segredos. Rotacione ou revogue imediatamente as credenciais confirmadas.'
    }
  },
  {
    key: 'pdf-bench', index: '12', status: { en: 'Local PDF', pt: 'PDF local' },
    schemaCategory: 'UtilitiesApplication',
    title: { en: 'PDF Bench', pt: 'PDF Bench' },
    subtitle: { en: 'Local PDF workbench', pt: 'Bancada local de PDF' },
    description: {
      en: 'Merge, split, reorder, rotate, and remove common document metadata from PDFs without uploading them.',
      pt: 'Una, divida, reordene, gire e remova metadados comuns de PDFs sem enviá-los.'
    },
    privacy: { en: 'PDF bytes stay in this tab · Library loads on demand', pt: 'Os bytes do PDF ficam nesta aba · Biblioteca sob demanda' },
    paths: { en: '/tools/pdf-bench/', pt: '/pt-br/ferramentas/pdf-bench/' },
    note: {
      en: 'Files are copied into a new document in the order you choose. Export requires an explicit confirmation and reports the resulting size.',
      pt: 'Os arquivos são copiados para um novo documento na ordem escolhida. A exportação exige confirmação e informa o tamanho final.'
    },
    limits: {
      en: 'This tool does not repair tagged-PDF accessibility, OCR scans, decrypt protected files, or guarantee secure deletion of embedded objects.',
      pt: 'A ferramenta não repara acessibilidade, não faz OCR, não descriptografa arquivos protegidos e não garante a remoção segura de objetos embutidos.'
    }
  },
  {
    key: 'private-transcriber', index: '13', status: { en: 'On-device AI', pt: 'IA no dispositivo' },
    schemaCategory: 'MultimediaApplication',
    title: { en: 'Private Transcriber', pt: 'Transcritor privado' },
    subtitle: { en: 'On-device Whisper transcription', pt: 'Transcrição Whisper no dispositivo' },
    description: {
      en: 'Transcribe local audio with a small Whisper model in the browser, include timestamps, and export TXT, VTT, or SRT.',
      pt: 'Transcreva áudio local com um modelo Whisper pequeno no navegador, gere marcações de tempo e exporte TXT, VTT ou SRT.'
    },
    privacy: { en: 'Audio stays local · Model weights are downloaded on first use', pt: 'O áudio fica local · Pesos do modelo são baixados no primeiro uso' },
    paths: { en: '/tools/private-transcriber/', pt: '/pt-br/ferramentas/transcritor-privado/' },
    note: {
      en: 'The first run downloads model weights from Hugging Face. After that, browser caching may reuse them. The selected audio is decoded and processed locally.',
      pt: 'A primeira execução baixa os pesos do Hugging Face. Depois, o cache do navegador pode reutilizá-los. O áudio selecionado é decodificado e processado localmente.'
    },
    limits: {
      en: 'Input files are capped at 48 MiB; decoded audio is capped at 3 minutes and an estimated 96 MiB of 16 kHz PCM because decoding is not streamed. Accuracy depends on language, audio quality, speakers, noise, and device support; always review transcripts.',
      pt: 'Os arquivos de entrada são limitados a 48 MiB; o áudio decodificado é limitado a 3 minutos e a uma estimativa de 96 MiB de PCM a 16 kHz, pois a decodificação não é feita em fluxo. A precisão depende de idioma, qualidade, falantes, ruído e suporte do dispositivo; sempre revise a transcrição.'
    }
  }
];

newTools.push(...suiteTools);

export const allTools = [...originalTools, ...newTools];
export const toolRoutes = allTools.flatMap((tool) => [tool.paths.en, tool.paths.pt]);
