const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", async () => {
  const slider = document.getElementById("scale");
  const output = document.getElementById("percent");
  slider.value = await ipcRenderer.invoke("pet:scale");
  output.value = `${slider.value}%`;
  slider.disabled = false;
  slider.focus();
  slider.addEventListener("input", () => {
    output.value = `${slider.value}%`;
    ipcRenderer.invoke("pet:scale", slider.valueAsNumber);
  });
});
