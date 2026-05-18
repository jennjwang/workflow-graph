import dagre from 'dagre';
import { Node, Edge } from '@xyflow/react';
import { WorkflowNodeData } from '../types';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;
export const LANE_HEIGHT = 280;
export const LANE_HEADER_WIDTH = 52;
const LANE_PAD = (LANE_HEIGHT - NODE_HEIGHT) / 2;

// Recursive subtree-grouped tree layout for LR mode. Unlike dagre's tight-tree
// (which only enforces per-rank ordering and freely interleaves siblings of
// different parents in the same column), this assigns each subtree a contiguous
// vertical band: every child is positioned directly inside its parent's band,
// never overlapping with a cousin's subtree. The parent is then vertically
// centered between its first and last child's Y.
//
// Honours per-node `collapsed` (descendants are dropped) and manualPositions
// (override). `edges` is unused here — the tree is reconstructed from each
// node's `parentId`, which is the single source of truth.
const RANK_SEP = 80;       // horizontal gap between depths
const SIBLING_GAP = 24;    // vertical gap between subtree bands
export function layoutTree(
  nodes: Node<WorkflowNodeData>[],
  _edges: Edge[],
  manualPositions: Record<string, { x: number; y: number }> = {}
): Node<WorkflowNodeData>[] {
  if (nodes.length === 0) return nodes;

  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const childrenByParent: Record<string, Node<WorkflowNodeData>[]> = {};
  for (const n of nodes) {
    const pid = n.data.parentId as string | undefined;
    if (pid) (childrenByParent[pid] ||= []).push(n);
  }
  // Stable sibling order: by original creation order in the nodes array.
  for (const group of Object.values(childrenByParent)) {
    group.sort((a, b) => (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0));
  }

  // Hide descendants of any collapsed node so they don't claim layout space.
  const hidden = new Set<string>();
  const collapseQueue: string[] = nodes.filter(n => n.data.collapsed).map(n => n.id);
  while (collapseQueue.length) {
    const pid = collapseQueue.shift()!;
    for (const c of childrenByParent[pid] ?? []) {
      if (!hidden.has(c.id)) {
        hidden.add(c.id);
        collapseQueue.push(c.id);
      }
    }
  }

  const placed = new Map<string, { x: number; y: number }>();

  // Layout the subtree rooted at nodeId. Returns the total vertical pixels
  // consumed (from yTop downward, inclusive of all descendants' bands).
  function place(nodeId: string, depth: number, yTop: number): number {
    if (hidden.has(nodeId)) return 0;
    const x = depth * (NODE_WIDTH + RANK_SEP);
    const kids = (childrenByParent[nodeId] ?? []).filter(c => !hidden.has(c.id));

    if (kids.length === 0) {
      placed.set(nodeId, { x, y: yTop });
      return NODE_HEIGHT;
    }

    let yCursor = yTop;
    for (let i = 0; i < kids.length; i++) {
      const h = place(kids[i].id, depth + 1, yCursor);
      yCursor += h + (i < kids.length - 1 ? SIBLING_GAP : 0);
    }
    const subtreeHeight = yCursor - yTop;

    // Centre the parent between its first and last child's actual Y.
    const firstY = placed.get(kids[0].id)!.y;
    const lastY = placed.get(kids[kids.length - 1].id)!.y;
    placed.set(nodeId, { x, y: (firstY + lastY) / 2 });

    // A parent with only one (short) child can leave the band shorter than
    // NODE_HEIGHT, which would let an adjacent sibling subtree overlap it
    // vertically. Pad upward to at least NODE_HEIGHT.
    return Math.max(subtreeHeight, NODE_HEIGHT);
  }

  // Place each root subtree stacked vertically.
  const roots = nodes.filter(n => !n.data.parentId && !hidden.has(n.id));
  let yCursor = 0;
  for (let i = 0; i < roots.length; i++) {
    const h = place(roots[i].id, 0, yCursor);
    yCursor += h + (i < roots.length - 1 ? SIBLING_GAP : 0);
  }

  const visible = nodes.filter(n => !hidden.has(n.id) && placed.has(n.id));
  return visible.map(n => {
    if (manualPositions[n.id]) return { ...n, position: manualPositions[n.id] };
    return { ...n, position: placed.get(n.id)! };
  });
}

// Standard dagre layout (no lanes). Top-level (parentId-less) flow runs LR.
// Children of a parent (subtasks) are stacked below the parent inside a group container.
// Group container nodes are emitted as type='group' (rendered behind the actual nodes).
export function layoutNodes(
  nodes: Node<WorkflowNodeData>[],
  edges: Edge[],
  manualPositions: Record<string, { x: number; y: number }> = {}
): Node<WorkflowNodeData>[] {
  if (nodes.length === 0) return nodes;

  const topLevelNodes = nodes.filter(n => !n.data.parentId);
  const childrenByParent: Record<string, Node<WorkflowNodeData>[]> = {};
  for (const n of nodes) {
    const pid = n.data.parentId as string | undefined;
    if (pid) {
      (childrenByParent[pid] ||= []).push(n);
    }
  }

  const CHILD_GAP_X = 80; // horizontal gap between parent and the child column
  const CHILD_STACK_GAP = 36; // vertical breathing room between stacked sub-steps

  // Effective dimensions per top-level node — parents with expanded children take more horizontal space (children sit to the right).
  const effectiveDims = (parent: Node<WorkflowNodeData>) => {
    const kids = childrenByParent[parent.id];
    if (!kids || kids.length === 0 || parent.data.collapsed) {
      return { width: NODE_WIDTH, height: NODE_HEIGHT };
    }
    return {
      width: NODE_WIDTH * 2 + CHILD_GAP_X,
      height: Math.max(NODE_HEIGHT, kids.length * NODE_HEIGHT + (kids.length - 1) * CHILD_STACK_GAP),
    };
  };

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 100, ranksep: 50, acyclicer: 'greedy', ranker: 'tight-tree' });
  const topIds = new Set(topLevelNodes.map(n => n.id));
  topLevelNodes.forEach(n => {
    const { width, height } = effectiveDims(n);
    g.setNode(n.id, { width, height });
  });

  const topEdges = edges.filter(e => topIds.has(e.source) && topIds.has(e.target));
  topEdges.forEach(e => g.setEdge(e.source, e.target));

  if (topLevelNodes.length > 1 && topEdges.length === 0) {
    for (let i = 0; i < topLevelNodes.length - 1; i++) {
      g.setEdge(topLevelNodes[i].id, topLevelNodes[i + 1].id);
    }
  }

  dagre.layout(g);

  // Position parent at the TOP-LEFT of its allotted footprint so children stack downward and rightward
  // without overflowing into the next node's space.
  const positioned = topLevelNodes.map(n => {
    if (manualPositions[n.id]) return { ...n, position: manualPositions[n.id] };
    const pos = g.node(n.id);
    const dims = effectiveDims(n);
    return {
      ...n,
      position: {
        x: pos.x - dims.width / 2,
        y: pos.y - dims.height / 2,
      },
    };
  });

  const childPositioned: Node<WorkflowNodeData>[] = [];
  const backdropNodes: Node<WorkflowNodeData>[] = [];
  const BACKDROP_PAD = 22;

  for (const parent of positioned) {
    const kids = childrenByParent[parent.id];
    if (!kids || kids.length === 0) continue;
    if (parent.data.collapsed) continue;

    const childX = parent.position.x + NODE_WIDTH + CHILD_GAP_X;
    kids.forEach((kid, i) => {
      if (manualPositions[kid.id]) {
        childPositioned.push({ ...kid, position: manualPositions[kid.id] });
      } else {
        childPositioned.push({
          ...kid,
          position: {
            x: childX,
            y: parent.position.y + i * (NODE_HEIGHT + CHILD_STACK_GAP),
          },
        });
      }
    });

    // Backdrop behind the subtask stack only (does not include the parent)
    backdropNodes.push({
      id: `__backdrop__${parent.id}`,
      type: 'subtaskBackdrop',
      position: { x: childX - BACKDROP_PAD, y: parent.position.y - BACKDROP_PAD },
      data: { label: '', description: '', nodeType: 'task' },
      style: {
        width: NODE_WIDTH + BACKDROP_PAD * 2,
        height: kids.length * NODE_HEIGHT + (kids.length - 1) * CHILD_STACK_GAP + BACKDROP_PAD * 2,
      },
      draggable: false,
      selectable: false,
      zIndex: -1,
    });
  }

  // Backdrops first so they render behind the actual nodes
  return [...backdropNodes, ...positioned, ...childPositioned];
}

// Swimlane layout: horizontal bands (TB within each lane), flow left→right across lanes
export function layoutSwimlanes(
  nodes: Node<WorkflowNodeData>[],
  edges: Edge[],
  lanes: string[],
  manualPositions: Record<string, { x: number; y: number }> = {}
): Node<WorkflowNodeData>[] {
  if (nodes.length === 0) return nodes;
  if (lanes.length === 0) return layoutNodes(nodes, edges, manualPositions);

  const defaultLane = lanes[0];
  const getActor = (n: Node<WorkflowNodeData>) => {
    const a = n.data.actor as string | undefined;
    return a && lanes.includes(a) ? a : defaultLane;
  };

  // Run dagre LR to determine x ranks
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 180, acyclicer: 'greedy', ranker: 'network-simplex' });
  nodes.forEach(n => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);

  return nodes.map(n => {
    if (manualPositions[n.id]) return { ...n, position: manualPositions[n.id] };
    const dagrePos = g.node(n.id);
    const laneIdx = lanes.indexOf(getActor(n));
    return {
      ...n,
      position: {
        x: LANE_HEADER_WIDTH + (dagrePos.x - NODE_WIDTH / 2),
        y: laneIdx * LANE_HEIGHT + LANE_PAD,
      },
    };
  });
}
