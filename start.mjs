import { launch } from "./launch.mjs";
const pet = launch(process.env);
pet.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
pet.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
