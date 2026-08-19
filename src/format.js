function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Telegram HTML parse_mode chokes on raw <, >, & in message text — names
// pulled from Telegram profiles can contain any of these.
function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A clipper's name for display: @username stays plain (Telegram auto-links
// and highlights it already), a bare display name gets bolded so it still
// stands out the same way in text.
function nameTag(entity) {
  return entity.username ? `@${escapeHtml(entity.username)}` : `<b>${escapeHtml(entity.display_name)}</b>`;
}

module.exports = { formatDuration, escapeHtml, nameTag };
