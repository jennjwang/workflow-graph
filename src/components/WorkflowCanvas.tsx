import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls,
  NodeTypes, NodeChange, applyNodeChanges,
  ConnectionLineType, ConnectionMode,
  OnConnectStart, OnConnectEnd,
  useViewport, MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowStore } from '../store';
import { nodeTypes } from './nodes';
import { layoutNodes, layoutSwimlanes, LANE_HEIGHT, LANE_HEADER_WIDTH } from '../lib/layout';
import { WorkflowNodeData, NodeType } from '../types';
import { Node } from '@xyflow/react';

const LANE_COLORS = [
  { accent: '#6366f1', bg: '#f8f8ff', text: '#6366f1' }, // indigo
  { accent: '#8b5cf6', bg: '#faf8ff', text: '#8b5cf6' }, // violet
  { accent: '#0d9488', bg: '#f0fdfa', text: '#0d9488' }, // teal
  { accent: '#d97706', bg: '#fffbf0', text: '#d97706' }, // amber
  { accent: '#e11d48', bg: '#fff8f8', text: '#e11d48' }, // rose
];

const TYPE_OPTIONS: { type: NodeType; label: string; style: string }[] = [
  { type: 'task',     label: 'Task',     style: 'hover:bg-blue-50 hover:text-blue-700' },
  { type: 'decision', label: 'Decision', style: 'hover:bg-orange-50 hover:text-orange-700' },
  { type: 'handoff',  label: 'Handoff',  style: 'hover:bg-violet-50 hover:text-violet-700' },
  { type: 'input',    label: 'Input',    style: 'hover:bg-teal-50 hover:text-teal-700' },
  { type: 'failure',  label: 'Failure',  style: 'hover:bg-red-50 hover:text-red-700' },
  { type: 'wait',     label: 'Wait',     style: 'hover:bg-amber-50 hover:text-amber-700' },
  { type: 'end',      label: 'End',      style: 'hover:bg-slate-100 hover:text-slate-700' },
];

function SwimlaneOverlay({ lanes, viewport }: { lanes: string[]; viewport: { x: number; y: number; zoom: number } }) {
  if (lanes.length === 0) return null;
  const offsetY = viewport.y;
  const headerW = LANE_HEADER_WIDTH * viewport.zoom;
  const laneH = LANE_HEIGHT * viewport.zoom;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {/* Header column background */}
      <div className="absolute top-0 bottom-0 bg-white z-10 border-r border-slate-100" style={{ left: 0, width: headerW }} />

      {lanes.map((lane, i) => {
        const c = LANE_COLORS[i % LANE_COLORS.length];
        const top = offsetY + i * laneH;
        return (
          <div key={lane} className="absolute left-0 right-0" style={{ top, height: laneH }}>
            {/* Lane tinted background */}
            <div className="absolute inset-0" style={{ backgroundColor: c.bg, opacity: 0.6 }} />
            {/* Bottom separator */}
            <div className="absolute bottom-0 left-0 right-0 border-b border-slate-100" />
            {/* Colored accent strip */}
            <div className="absolute top-0 bottom-0 z-20" style={{ left: 0, width: Math.max(3, 3 * viewport.zoom), backgroundColor: c.accent }} />
            {/* Lane label */}
            <div className="absolute top-0 bottom-0 z-10 flex items-center justify-center" style={{ left: 0, width: headerW }}>
              <span
                className="font-semibold uppercase tracking-widest select-none whitespace-nowrap"
                style={{
                  color: c.text,
                  fontSize: Math.max(8, 10 * viewport.zoom),
                  transform: 'rotate(-90deg)',
                  maxWidth: laneH - 16,
                  letterSpacing: '0.12em',
                }}
              >
                {lane}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ViewportSwimlane({ lanes }: { lanes: string[] }) {
  const viewport = useViewport();
  return <SwimlaneOverlay lanes={lanes} viewport={viewport} />;
}

export function WorkflowCanvas() {
  const nodes           = useWorkflowStore(s => s.nodes);
  const edges           = useWorkflowStore(s => s.edges);
  const lanes           = useWorkflowStore(s => s.lanes);
  const walkerOverlayNodes = useWorkflowStore(s => s.walkerOverlayNodes);
  const walkerOverlayEdges = useWorkflowStore(s => s.walkerOverlayEdges);
  const manualPositions = useWorkflowStore(s => s.manualPositions);
  const setManualPosition = useWorkflowStore(s => s.setManualPosition);
  const onEdgesChange   = useWorkflowStore(s => s.onEdgesChange);
  const onConnect       = useWorkflowStore(s => s.onConnect);
  const deleteNodes     = useWorkflowStore(s => s.deleteNodes);
  const createNode      = useWorkflowStore(s => s.createNode);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rfInstance = useRef<any>(null);
  const connectingNodeId = useRef<string | null>(null);
  const connectionMade = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const [rfNodes, setRfNodes] = useState<Node<WorkflowNodeData>[]>([]);
  const [popup, setPopup] = useState<{ sourceId: string; canvasX: number; canvasY: number; screenX: number; screenY: number } | null>(null);

  const laidNodes = useMemo(
    () => lanes.length > 0
      ? layoutSwimlanes(nodes, edges, lanes, manualPositions)
      : layoutNodes(nodes, edges, manualPositions),
    [nodes, edges, lanes, manualPositions]
  );

  useEffect(() => {
    if (!draggingRef.current) setRfNodes(laidNodes);
  }, [laidNodes]);

  // Compose final node list: real laid-out nodes + walker ghost/card overlay nodes
  const renderedNodes = useMemo(() => [...rfNodes, ...walkerOverlayNodes], [rfNodes, walkerOverlayNodes]);
  const renderedEdges = useMemo(() => [...edges, ...walkerOverlayEdges], [edges, walkerOverlayEdges]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes(nds => applyNodeChanges(changes, nds) as Node<WorkflowNodeData>[]);
      const removedIds = changes.filter(c => c.type === 'remove').map(c => c.id);
      if (removedIds.length) deleteNodes(removedIds);
      for (const change of changes) {
        if (change.type === 'position') {
          if (change.dragging) {
            draggingRef.current = true;
          } else if (change.position) {
            draggingRef.current = false;
            setManualPosition(change.id, change.position);
          }
        }
      }
    },
    [setManualPosition, deleteNodes]
  );

  const handleConnect = useCallback(
    (connection: Parameters<typeof onConnect>[0]) => {
      connectionMade.current = true;
      onConnect(connection);
    },
    [onConnect]
  );

  const handleConnectStart: OnConnectStart = useCallback((_, { nodeId }) => {
    connectingNodeId.current = nodeId ?? null;
    connectionMade.current = false;
  }, []);

  const handleConnectEnd: OnConnectEnd = useCallback((event, connectionState) => {
    const droppedOnEmpty = connectionState.isValid !== true;
    if (droppedOnEmpty && connectingNodeId.current) {
      const isMouse = 'clientX' in event;
      const clientX = isMouse ? (event as MouseEvent).clientX : (event as TouchEvent).changedTouches[0]?.clientX ?? 0;
      const clientY = isMouse ? (event as MouseEvent).clientY : (event as TouchEvent).changedTouches[0]?.clientY ?? 0;
      const rect = canvasRef.current?.getBoundingClientRect();
      setPopup({
        sourceId: connectingNodeId.current,
        canvasX: clientX - (rect?.left ?? 0),
        canvasY: clientY - (rect?.top ?? 0),
        screenX: clientX,
        screenY: clientY,
      });
    }
    connectingNodeId.current = null;
    connectionMade.current = false;
  }, []);

  const handleCreateNode = useCallback(
    (type: NodeType) => {
      if (!popup || !rfInstance.current) return;
      const flowPos = rfInstance.current.screenToFlowPosition({ x: popup.screenX, y: popup.screenY });
      createNode(type, flowPos, popup.sourceId);
      setPopup(null);
    },
    [popup, createNode]
  );

  return (
    <div ref={canvasRef} className="flex-1 h-full relative">
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes as NodeTypes}
        onInit={instance => { rfInstance.current = instance; }}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        nodesDraggable
        nodesConnectable
        deleteKeyCode={['Backspace', 'Delete']}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionMode={ConnectionMode.Strict}
        connectionRadius={40}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { stroke: '#94a3b8', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 14, height: 14 },
        }}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#f0f0f0" />
        <Controls className="!shadow-sm !border !border-gray-200 !rounded-lg overflow-hidden" />
        {lanes.length > 0 && <ViewportSwimlane lanes={lanes} />}
      </ReactFlow>

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-gray-300 text-sm">Graph will appear here as you talk</p>
        </div>
      )}

      {nodes.length > 0 && nodes.length < 3 && lanes.length === 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none">
          <p className="text-xs text-gray-300 bg-white/80 px-3 py-1 rounded-full border border-gray-100 shadow-sm">
            Double-click to edit · drag to reposition · select + Delete to remove
          </p>
        </div>
      )}

      {popup && (
        <>
          <div className="absolute inset-0 z-40" onMouseDown={() => setPopup(null)} />
          <div
            className="absolute z-50 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden w-36"
            style={{ left: popup.canvasX, top: popup.canvasY }}
            onMouseDown={e => e.stopPropagation()}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 px-3 pt-2.5 pb-1">Add node</p>
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.type}
                onClick={() => handleCreateNode(opt.type)}
                className={`w-full text-left px-3 py-2 text-sm font-medium text-gray-600 transition ${opt.style}`}
              >
                {opt.label}
              </button>
            ))}
            <button
              onClick={() => setPopup(null)}
              className="w-full text-left px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 transition border-t border-gray-100"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
