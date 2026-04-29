import { defineConfig } from "@prisma/config";

export default defineConfig({
  earlyAccess: true,
  schema: "./prisma/schema.prisma",
  migrate: {
    async adapter() {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const connectionString = process.env["DATABASE_URL"];
      if (!connectionString) throw new Error("DATABASE_URL is not set");
      return new PrismaPg({ connectionString });
    },
  },
});
