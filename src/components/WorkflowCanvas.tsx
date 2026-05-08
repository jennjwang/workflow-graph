import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  NodeTypes, NodeChange, applyNodeChanges,
  ConnectionLineType, ConnectionMode,
  OnConnectStart, OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowStore } from '../store';
import { nodeTypes } from './nodes';
import { layoutNodes } from '../lib/layout';
import { WorkflowNodeData, NodeType } from '../types';
import { Node } from '@xyflow/react';

const TYPE_OPTIONS: { type: NodeType; label: string; style: string }[] = [
  { type: 'task',     label: 'Task',     style: 'hover:bg-blue-50 hover:text-blue-700' },
  { type: 'decision', label: 'Decision', style: 'hover:bg-orange-50 hover:text-orange-700' },
];

export function WorkflowCanvas() {
  const nodes          = useWorkflowStore(s => s.nodes);
  const edges          = useWorkflowStore(s => s.edges);
  const manualPositions = useWorkflowStore(s => s.manualPositions);
  const setManualPosition = useWorkflowStore(s => s.setManualPosition);
  const onEdgesChange  = useWorkflowStore(s => s.onEdgesChange);
  const onConnect      = useWorkflowStore(s => s.onConnect);
  const deleteNodes    = useWorkflowStore(s => s.deleteNodes);
  const createNode     = useWorkflowStore(s => s.createNode);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rfInstance = useRef<any>(null);
  const connectingNodeId = useRef<string | null>(null);
  const connectionMade = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const [rfNodes, setRfNodes] = useState<Node<WorkflowNodeData>[]>([]);
  const [popup, setPopup] = useState<{ sourceId: string; canvasX: number; canvasY: number; screenX: number; screenY: number } | null>(null);

  const laidNodes = useMemo(
    () => layoutNodes(nodes, edges, manualPositions),
    [nodes, edges, manualPositions]
  );

  useEffect(() => {
    if (!draggingRef.current) setRfNodes(laidNodes);
  }, [laidNodes]);

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
    console.log('[connect] start, nodeId=', nodeId);
    connectingNodeId.current = nodeId ?? null;
    connectionMade.current = false;
  }, []);

  const handleConnectEnd: OnConnectEnd = useCallback((event, connectionState) => {
    console.log('[connect] end', {
      connectionMade: connectionMade.current,
      sourceId: connectingNodeId.current,
      isValid: connectionState.isValid,
      from: connectionState.from,
    });
    // isValid is null when cursor is on open canvas, false near an invalid handle
    const droppedOnEmpty = connectionState.isValid !== true;
    if (droppedOnEmpty && connectingNodeId.current) {
      const isMouse = 'clientX' in event;
      const clientX = isMouse ? (event as MouseEvent).clientX : (event as TouchEvent).changedTouches[0]?.clientX ?? 0;
      const clientY = isMouse ? (event as MouseEvent).clientY : (event as TouchEvent).changedTouches[0]?.clientY ?? 0;
      const rect = canvasRef.current?.getBoundingClientRect();
      console.log('[connect] showing popup at canvas coords', {
        clientX, clientY, rect,
        canvasX: clientX - (rect?.left ?? 0),
        canvasY: clientY - (rect?.top ?? 0),
      });
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
      const flowPos = rfInstance.current.screenToFlowPosition({
        x: popup.screenX,
        y: popup.screenY,
      });
      createNode(type, flowPos, popup.sourceId);
      setPopup(null);
    },
    [popup, createNode]
  );

  return (
    <div ref={canvasRef} className="flex-1 h-full relative">
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
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
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#f0f0f0" />
        <Controls className="!shadow-sm !border !border-gray-200 !rounded-lg overflow-hidden" />
        <MiniMap nodeStrokeWidth={2} zoomable pannable className="!border !border-gray-200 !rounded-lg !shadow-sm" />
      </ReactFlow>

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-gray-300 text-sm">Graph will appear here as you talk</p>
        </div>
      )}

      {nodes.length > 0 && nodes.length < 3 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none">
          <p className="text-xs text-gray-300 bg-white/80 px-3 py-1 rounded-full border border-gray-100 shadow-sm">
            Hover a node to connect (<span className="font-bold">+</span>) · drag to reposition · select + Delete to remove
          </p>
        </div>
      )}

      {/* Node creation popup + dismiss overlay */}
      {popup && (
        <>
          <div className="absolute inset-0 z-40" onMouseDown={() => setPopup(null)} />
          <div
            className="absolute z-50 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden w-36"
            style={{ left: popup.canvasX, top: popup.canvasY }}
            onMouseDown={e => e.stopPropagation()}
          >
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 px-3 pt-2.5 pb-1">
            Add node
          </p>
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
