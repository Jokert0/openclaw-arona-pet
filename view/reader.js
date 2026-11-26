const content = document.querySelector("main");
window.replyReader.onText((text, reset) => {
  const top = content.scrollTop;
  const atEnd = content.scrollHeight - content.clientHeight - top <= 2;
  content.textContent = text;
  content.scrollTop = reset ? 0 : atEnd ? content.scrollHeight : top;
});
document.querySelector("button").addEventListener("click", () => window.close());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});
