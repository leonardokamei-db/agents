import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone reduz a imagem de deploy (Railway/containers) e não atrapalha `next start`.
  output: "standalone",
  // postgres.js, groq-sdk e unpdf rodam só no servidor; mantém-os fora do bundle client.
  serverExternalPackages: ["postgres", "unpdf"],
  // O type-check do build continua ativo; só o lint não bloqueia o deploy
  // (rode `npm run lint` separadamente).
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
