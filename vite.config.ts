import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Gesprächsarchiv KI",
        short_name: "Gespräche",
        description: "Aufnehmen, transkribieren und als strukturiertes Protokoll archivieren.",
        theme_color: "#f8fafc",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/pwa-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any maskable"
          },
          {
            src: "/pwa-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"]
      }
    })
  ]
});
