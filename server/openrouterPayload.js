function normalizeParts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

export function hasOpenRouterFileParts(messages) {
  return (messages || []).some((message) =>
    normalizeParts(message?.content).some((part) => part?.type === 'file' && part?.file)
  );
}

export function buildOpenRouterPlugins({
  nativeWebSearch = false,
  messages = [],
  webPluginId = 'web',
  filePluginId = 'file-parser',
  pdfEngine = 'pdf-text',
}) {
  const plugins = [];
  if (nativeWebSearch) {
    plugins.push({ id: webPluginId });
  }
  if (hasOpenRouterFileParts(messages)) {
    const filePlugin = { id: filePluginId };
    if (pdfEngine) {
      filePlugin.pdf = { engine: pdfEngine };
    }
    plugins.push(filePlugin);
  }
  return plugins;
}
