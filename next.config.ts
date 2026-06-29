import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone reduz a imagem de deploy (Railway/containers) e não atrapalha `next start`.
  output: "standalone",
  // postgres.js e unpdf rodam só no servidor; mantém-os fora do bundle client.
  // (@anthropic-ai/sdk é JS puro e roda bem no bundle do servidor — sem entrada aqui.)
  serverExternalPackages: ["postgres", "unpdf"],
  // O type-check do build continua ativo; só o lint não bloqueia o deploy
  // (rode `npm run lint` separadamente).
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
