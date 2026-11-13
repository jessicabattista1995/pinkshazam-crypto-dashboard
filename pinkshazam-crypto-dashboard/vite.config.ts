import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base "./" keeps asset paths relative, so the build works from a domain root
// and from a sub-path such as https://<user>.github.io/<repo>/.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
