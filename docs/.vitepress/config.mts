import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Antigravity",
  description: "Vector-Tree Engine Documentation",
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Developer', link: '/developer/workflow' }
    ],

    sidebar: [
      {
        text: '📚 Guide & Onboarding',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Core Concepts', link: '/guide/core-concepts' },
          { text: 'The Six Pillars', link: '/guide/the-six-pillars' }
        ]
      },
      {
        text: '🛠️ Developer Manual',
        items: [
          { text: 'Workflow', link: '/developer/workflow' },
          { text: 'CLI Reference', link: '/developer/cli-reference' },
          { text: 'Creating Features', link: '/developer/creating-features' },
          { text: 'State & Data', link: '/developer/state-and-data' },
          { text: 'Magic Comments', link: '/developer/magic-comments' },
          { text: 'Refactoring', link: '/developer/refactoring' }
        ]
      },
      {
        text: '🧠 Architecture Decisions (ADR)',
        items: [
          { text: '001: Vector-Tree vs FS', link: '/adr/001-vector-tree-over-fs' },
          { text: '002: Magic Comments', link: '/adr/002-magic-comments' },
          { text: '003: MCP Native Server', link: '/adr/003-mcp-server-native' }
        ]
      },
      {
        text: '🤖 AI Agents',
        items: [
          { text: 'Overview', link: '/ai-agents/overview' },
          { text: 'MCP Tools', link: '/ai-agents/mcp-tools' }
        ]
      },
      {
        text: '⚙️ Reference',
        items: [
          { text: 'Autodocs', link: '/reference/autodocs' },
          { text: 'Topology Map', link: '/reference/topology-map' }
        ]
      },
      {
        text: '🗓️ Planning',
        items: [
          { text: 'Phase Plan', link: '/planning/phase-plan' },
          { text: 'Migration Plan', link: '/planning/migration-plan' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hozantaher/antigravity' }
    ]
  }
})
