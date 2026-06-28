import { UnifiedVectorEngine } from './engine';
import { CyberneticGovernor } from './governor';
import { TransactionalRefactorEngine } from './refactor';

export class MCPServer {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
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
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: `Node renamed successfully. Plan executed:\n${plan.join('\n')}` }]
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
