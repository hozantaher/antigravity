import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  MarkerType
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion } from 'framer-motion';
import { Brain, Cpu, HandMetal, Globe } from 'lucide-react';
import initialNodes from './data/map-nodes.json';
import initialEdges from './data/map-edges.json';

const icons = {
  CORE: Cpu,
  BRAIN: Brain,
  HANDS: HandMetal,
  BODY: Globe
};

// Define custom node types
const CustomNode = ({ data }: any) => {
  const Icon = icons[data.layer as keyof typeof icons] || Cpu;
  return (
    <div className={`ag-node layer-${data.layer.toLowerCase()}`}>
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="node-header">
        <Icon size={16} />
        <span>{data.label}</span>
      </div>
      <div className="node-layer-badge" style={{ marginBottom: '6px', display: 'inline-block' }}>
        {data.layer}
      </div>
      <p className="node-desc">{data.description}</p>
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
};

const nodeTypes = {
  antigravityNode: CustomNode,
};

export default function MissionControl() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    // The generator already maps them into React Flow format { id, position, data, type }
    // We just inject our custom icons logic via the CustomNode component above
    setNodes(initialNodes);
    setEdges(initialEdges.map(edge => ({
      ...edge,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edge.style?.stroke || 'rgba(255, 255, 255, 0.3)',
      }
    })));
  }, []);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1 }}
      style={{ width: '100vw', height: '100vh' }}
    >
      <header className="app-header glass-panel">
        <motion.h1 
          className="app-title"
          initial={{ y: -20 }}
          animate={{ y: 0 }}
          transition={{ delay: 0.2, type: 'spring' }}
        >
          Antigravity OS
        </motion.h1>
        <p className="app-subtitle">Mission Control / Vector-Tree</p>
      </header>

      <div className="stats-panel glass-panel">
        <div className="stat-item">
          <span className="stat-label">Nodes</span>
          <span className="stat-value">{nodes.length}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Active Edges</span>
          <span className="stat-value">{edges.length}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">System Status</span>
          <span className="stat-value" style={{ color: '#10b981' }}>Nominal</span>
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        className="dark"
      >
        <Background color="#ffffff" gap={24} size={1} opacity={0.05} />
        <Controls />
      </ReactFlow>
    </motion.div>
  );
}
