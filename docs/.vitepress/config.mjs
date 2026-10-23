const repository = "https://github.com/MerlijnW70/solive";

export default {
  title: "Solive",
  description: "Orders on Solana that solvers fill, and escrows that pay out only when the work checks out.",
  base: "/solive/",
  cleanUrls: true,
  srcExclude: ["maintainers/**"],
  themeConfig: {
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
    editLink: { pattern: `${repository}/edit/main/docs/:path` },
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Quickstart", link: "/quickstart" },
          { text: "Your first paid job", link: "/first-job" },
          { text: "Use it from your AI", link: "/ai" },
          { text: "Build in TypeScript", link: "/sdk" },
          { text: "Run a solver", link: "/solver" },
          { text: "Judge work", link: "/judge" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Server options", link: "/mcp" },
          { text: "OpenClaw", link: "/openclaw" },
          { text: "Company-only jobs", link: "/private-jobs" },
          { text: "Agent mandates", link: "/mandate" },
          { text: "Reputation", link: "/reputation" },
          { text: "The full client", link: "/sdk-client" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Commands", link: "/reference/cli" },
          { text: "MCP tools", link: "/reference/mcp-tools" },
          { text: "Errors", link: "/reference/errors" },
          { text: "Engine errors", link: "/reference/engine-errors" },
        ],
      },
      {
        text: "Maintainers",
        items: [
          { text: "How the judge works", link: `${repository}/blob/main/docs/maintainers/judge-internals.md` },
          { text: "Operations", link: `${repository}/blob/main/docs/maintainers/operations.md` },
          { text: "Threat model", link: `${repository}/blob/main/docs/maintainers/threat-model.md` },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Report a vulnerability", link: `${repository}/blob/main/SECURITY.md` },
          { text: "Contributing", link: `${repository}/blob/main/CONTRIBUTING.md` },
        ],
      },
    ],
  },
  markdown: {
    config(md) {
      const link = md.renderer.rules.link_open;
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const href = tokens[index]?.attrGet("href") ?? "";
        const page = typeof env?.relativePath === "string" ? env.relativePath : "";
        if (href.startsWith("../") || href.startsWith("maintainers/")) {
          const from = page.includes("/") ? page.slice(0, page.lastIndexOf("/") + 1) : "";
          const target = new URL(href, `https://repo/docs/${from}`).pathname.slice(1);
          tokens[index]?.attrSet("href", `${repository}/blob/main/${target}`);
        }
        return link ? link(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
      };
    },
  },
};
