import dagre from 'dagre';
import { Node, Edge } from '@xyflow/react';
import { WorkflowNodeData } from '../types';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 110;

export function layoutNodes(
  nodes: Node<WorkflowNodeData>[],
  edges: Edge[],
  manualPositions: Record<string, { x: number; y: number }> = {}
): Node<WorkflowNodeData>[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 90 });

  nodes.forEach(n => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach(e => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map(n => {
    if (manualPositions[n.id]) {
      return { ...n, position: manualPositions[n.id] };
    }
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });
}
