import { UnifiedVectorEngine } from './engine';
import { CyberneticGovernor } from './governor';
import { TransactionalRefactorEngine } from './refactor';
import { ContextAwareScaffolder } from './scaffold';
import { FuzzyVectorRouter } from './router';
import { DiaryManager } from './diary';

export class MCPServer {
  private rootDir: string;
  private diary: DiaryManager;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.diary = new DiaryManager(rootDir);
  }

  public listen() {
    process.stdin.setEncoding('utf8');
    
    let buffer = '';

    process.stdin.on('data', async (chunk) => {
      buffer += chunk;
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep the incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const req = JSON.parse(line);
          const res = await this.handleRequest(req);
          if (res) {
            process.stdout.write(JSON.stringify(res) + '\n');
          }
        } catch (e: any) {
          process.stderr.write(`Failed to parse/handle request: ${e.message}\n`);
        }
      }
    });
  }

  private async handleRequest(req: any): Promise<any> {
    if (req.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            {
              name: 'antigravity_resolve_node',
              description: 'Resolves the context for a given vector-tree node (files and edges).',
              inputSchema: {
                type: 'object',
                properties: { nodeId: { type: 'string' } },
                required: ['nodeId']
              }
            },
            {
              name: 'antigravity_audit_drift',
              description: 'Checks the vector-tree architecture for broken links and heals them if requested.',
              inputSchema: {
                type: 'object',
                properties: { heal: { type: 'boolean' } },
                required: ['heal']
              }
            },
            {
              name: 'antigravity_rename_node',
              description: 'Safely renames and moves a node, patching all reverse links and edges.',
              inputSchema: {
                type: 'object',
                properties: { 
                  oldId: { type: 'string' },
                  newId: { type: 'string' },
                  newPath: { type: 'string' }
                },
                required: ['oldId', 'newId']
              }
            },
            {
              name: 'antigravity_create_node',
              description: 'Generates a new vector-tree node, inferring context and creating boilerplate files and reverse links.',
              inputSchema: {
                type: 'object',
                properties: { 
                  nodeId: { type: 'string' },
                  pathHint: { type: 'string' }
                },
                required: ['nodeId', 'pathHint']
              }
            },
            {
              name: 'antigravity_search_nodes',
              description: 'Searches the vector tree using fuzzy matching on node intent, tags, and structure.',
              inputSchema: {
                type: 'object',
                properties: { 
                  query: { type: 'string' }
                },
                required: ['query']
              }
            },
            {
              name: 'antigravity_project_overview',
              description: 'Generates a global architecture map with a Mermaid graph of the entire vector tree.',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            }
          ]
        }
      };
    }

    if (req.method === 'tools/call') {
      const toolName = req.params?.name;
      const args = req.params?.arguments || {};

      try {
        if (toolName === 'antigravity_resolve_node') {
          const engine = new UnifiedVectorEngine(this.rootDir);
          await engine.scan();
          const context = engine.resolveContext(args.nodeId);
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(context, null, 2) }]
            }
          };
        }

        if (toolName === 'antigravity_audit_drift') {
          const governor = new CyberneticGovernor(this.rootDir, args.heal);
          const report = await governor.audit();
          if (args.heal && report.length > 0) {
            this.diary.logAction('AI', 'AUDIT_HEAL', `Proveden audit s auto-heal. Nalezeno a opraveno ${report.length} problémů.`);
          }
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: report.join('\n') || 'No drift detected.' }]
            }
          };
        }

        if (toolName === 'antigravity_rename_node') {
          const refactor = new TransactionalRefactorEngine(this.rootDir);
          const plan = await refactor.planRename(args.oldId, args.newId, args.newPath);
          await refactor.executeRename(args.oldId, args.newId, args.newPath);
          
          this.diary.logAction('AI', 'RENAME_NODE', `Přejmenován uzel z ${args.oldId} na ${args.newId}`, [args.newId]);
          
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: `Node renamed successfully. Plan executed:\n${plan.join('\n')}` }]
            }
          };
        }

        if (toolName === 'antigravity_create_node') {
          const scaffolder = new ContextAwareScaffolder(this.rootDir);
          const report = scaffolder.generateNode(args.nodeId, args.pathHint);
          
          this.diary.logAction('AI', 'CREATE_NODE', `Vytvořen uzel ${args.nodeId} v cestě ${args.pathHint}`, [args.nodeId]);
          
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: `Node created successfully:\n${report.join('\n')}` }]
            }
          };
        }

        if (toolName === 'antigravity_search_nodes') {
          const router = new FuzzyVectorRouter(this.rootDir);
          const results = await router.search(args.query);
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
            }
          };
        }

        if (toolName === 'antigravity_project_overview') {
          const engine = new UnifiedVectorEngine(this.rootDir);
          await engine.scan();
          const md = engine.generateArchitectureMap();
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: md }]
            }
          };
        }
      } catch (e: any) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: e.message }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: 'Method not found' }
    };
  }
}
