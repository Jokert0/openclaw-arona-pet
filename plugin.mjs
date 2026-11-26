import { launch } from "./launch.mjs";
const descriptor = { name: "pet", description: "启动阿洛娜桌宠", hasSubcommands: true };
export default {
  id: "openclaw-arona-pet",
  name: "阿洛娜桌宠",
  register(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command("pet")
          .description(descriptor.description)
          .command("start")
          .action(() => {
            const child = launch(process.env, true);
            return new Promise((resolve, reject) => {
              child.once("error", reject);
              child.once("spawn", () => {
                child.unref();
                resolve();
              });
            });
          });
      },
      { descriptors: [descriptor] },
    );
  },
};
