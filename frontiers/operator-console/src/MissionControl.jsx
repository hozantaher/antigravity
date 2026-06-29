import React, { useMemo } from 'react';
import { ReactFlow, MiniMap, Controls, Background, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion } from 'framer-motion';

// Předgenerovaná data
import initialNodes from './data/map-nodes.json';
import initialEdges from './data/map-edges.json';

// Vlastní komponent pro Uzel s krásným designem
const AntigravityNode = ({ data }) => {
  return (
    <motion.div 
      whileHover={{ scale: 1.05 }}
      style={{
        padding: '10px 20px',
        borderRadius: '8px',
        background: '#1F2937',
        color: 'white',
        border: `2px solid ${data.color}`,
        boxShadow: `0 0 15px ${data.color}40`,
        minWidth: '150px',
        textAlign: 'center',
        fontFamily: 'Inter, sans-serif'
      }}
    >
      <div style={{ fontSize: '10px', color: data.color, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
        {data.layer}
      </div>
      <div style={{ fontWeight: 'bold', fontSize: '14px' }}>
        {data.label}
      </div>
      {data.description && (
        <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px' }}>
          {data.description}
        </div>
      )}
    </motion.div>
  );
};

const nodeTypes = {
  antigravityNode: AntigravityNode
};

export default function MissionControl() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0B0F19' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background color="#374151" gap={16} />
        <Controls style={{ background: '#1F2937', color: 'white', fill: 'white' }} />
        <MiniMap 
          nodeColor={(n) => n.data?.color || '#fff'}
          style={{ background: '#111827' }}
          maskColor="#0B0F1980"
        />
      </ReactFlow>
      
      {/* HUD (Heads Up Display) */}
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 10, color: 'white', fontFamily: 'Inter, sans-serif' }}>
        <h1 style={{ margin: 0, fontSize: '24px', background: 'linear-gradient(to right, #3B82F6, #8B5CF6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Antigravity Mission Control
        </h1>
        <p style={{ margin: '4px 0 0', color: '#9CA3AF', fontSize: '14px' }}>
          Vector-Tree Visualizer | {nodes.length} Uzlů
        </p>
      </div>
    </div>
  );
}
