function truncateContent(content, maxChars) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n... (truncated)`;
}

function getInlineImageUrl(attachment) {
  const candidate = String(attachment?.dataUrl || attachment?.content || '').trim();
  if (!candidate) return '';
  return candidate.startsWith('data:image/') ? candidate : '';
}

export function buildAttachmentContent(text, attachments, options = {}) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const videoUrls = Array.isArray(options.videoUrls)
    ? options.videoUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : [];

  if (safeAttachments.length === 0 && videoUrls.length === 0) {
    return text;
  }

  const parts = [];
  const textAttachments = safeAttachments.filter((attachment) => attachment.category !== 'image');

  if (textAttachments.length > 0) {
    const attachmentText = textAttachments
      .map((attachment) => {
        if (attachment.content) {
          return `\n\n---\n**Attached file: ${attachment.name}**\n\`\`\`\n${truncateContent(attachment.content, 50000)}\n\`\`\``;
        }
        return `\n\n---\n**Attached file: ${attachment.name}**\n(Unable to extract text content from this file.)`;
      })
      .join('');
    text += attachmentText;
  }

  if (videoUrls.length > 0) {
    text += `\n\n---\n**Referenced videos:**\n${videoUrls.map((url) => `- ${url}`).join('\n')}`;
  }

  const imageAttachments = safeAttachments.filter((attachment) => attachment.category === 'image');
  const inlineImageAttachments = imageAttachments
    .map((attachment) => ({ inlineUrl: getInlineImageUrl(attachment) }))
    .filter((entry) => Boolean(entry.inlineUrl));
  const omittedImageNames = imageAttachments
    .filter((attachment) => !getInlineImageUrl(attachment))
    .map((attachment) => attachment.name)
    .filter(Boolean);

  if (omittedImageNames.length > 0) {
    text += `\n\n---\n**Attached images (not included inline):** ${omittedImageNames.join(', ')}`;
  }

  if (inlineImageAttachments.length > 0 || videoUrls.length > 0) {
    parts.push({ type: 'text', text });
    for (const { inlineUrl } of inlineImageAttachments) {
      parts.push({
        type: 'image_url',
        image_url: { url: inlineUrl },
      });
    }
    for (const url of videoUrls) {
      parts.push({
        type: 'video_url',
        video_url: { url },
      });
    }
    return parts;
  }

  return text;
}

export function buildAttachmentTextContent(text, attachments, options = {}) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const videoUrls = Array.isArray(options.videoUrls)
    ? options.videoUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : [];

  if (safeAttachments.length === 0 && videoUrls.length === 0) {
    return text;
  }

  const textAttachments = safeAttachments.filter((attachment) => attachment.category !== 'image');
  if (textAttachments.length > 0) {
    const attachmentText = textAttachments
      .map((attachment) => {
        if (attachment.content) {
          return `\n\n---\n**Attached file: ${attachment.name}**\n\`\`\`\n${truncateContent(attachment.content, 50000)}\n\`\`\``;
        }
        return `\n\n---\n**Attached file: ${attachment.name}**\n(Unable to extract text content from this file.)`;
      })
      .join('');
    text += attachmentText;
  }

  const imageAttachments = safeAttachments.filter((attachment) => attachment.category === 'image');
  if (imageAttachments.length > 0) {
    const imageList = imageAttachments.map((attachment) => attachment.name).join(', ');
    text += `\n\n---\n**Attached images (not included inline):** ${imageList}`;
  }

  if (videoUrls.length > 0) {
    text += `\n\n---\n**Referenced videos:**\n${videoUrls.map((url) => `- ${url}`).join('\n')}`;
  }

  return text;
}
