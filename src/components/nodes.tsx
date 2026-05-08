import { useEffect, useState } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { WorkflowNodeData, NodeType } from '../types';
import { useWorkflowStore } from '../store';

type WorkflowFlowNode = Node<WorkflowNodeData, NodeType>;

const TYPE_STYLES: Record<NodeType, { border: string; badge: string; bg: string }> = {
  start:    { border: 'border-l-green-500',  badge: 'bg-green-100 text-green-800',   bg: 'bg-green-50' },
  task:     { border: 'border-l-blue-500',   badge: 'bg-blue-100 text-blue-800',     bg: 'bg-white' },
  decision: { border: 'border-l-orange-500', badge: 'bg-orange-100 text-orange-800', bg: 'bg-orange-50' },
};

const PLUS_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath stroke='%2360a5fa' stroke-width='2' stroke-linecap='round' d='M6 2v8M2 6h8'/%3E%3C/svg%3E")`;

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

export function WorkflowNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const updateNodeLabel  = useWorkflowStore(s => s.updateNodeLabel);
  const editingNodeId    = useWorkflowStore(s => s.editingNodeId);
  const setEditingNodeId = useWorkflowStore(s => s.setEditingNodeId);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(data.label);

  const styles = TYPE_STYLES[data.nodeType] ?? TYPE_STYLES.task;

  useEffect(() => {
    if (editingNodeId === id) {
      setEditValue(data.label);
      setEditing(true);
      setEditingNodeId(null);
    }
  }, [editingNodeId, id, setEditingNodeId]);

  const startEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditValue(data.label);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== data.label) updateNodeLabel(id, trimmed);
  };

  return (
    <div
      className={`
        group relative rounded-lg border border-gray-200 border-l-4
        ${styles.border} ${styles.bg}
        shadow-sm p-3 w-[220px] min-h-[80px]
        transition-shadow duration-150
        ${selected ? 'shadow-md ring-2 ring-blue-400 ring-offset-1' : 'hover:shadow-md'}
      `}
    >
      {/* Target handle — small dot, always visible */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          width: 10, height: 10,
          borderRadius: '50%',
          backgroundColor: '#d1d5db',
          border: '2px solid white',
          top: -5,
          transform: 'translateX(-50%)',
        }}
      />

      {/* Pencil edit button — top-right, appears on hover */}
      {!editing && (
        <button
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity text-gray-500 hover:text-gray-700 p-0.5 rounded"
          onClick={startEdit}
          title="Edit label"
        >
          <PencilIcon />
        </button>
      )}

      {/* Label row */}
      <div className="flex items-start gap-2 pr-4">
        {editing ? (
          <input
            autoFocus
            className="text-sm font-semibold text-gray-800 leading-tight bg-transparent border-b-2 border-blue-400 outline-none w-full pb-0.5"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span
            className="text-sm font-semibold text-gray-800 leading-tight cursor-default select-none"
            onDoubleClick={startEdit}
          >
            {data.label}
          </span>
        )}
      </div>

      {/* Type badge */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded capitalize ${styles.badge}`}>
          {data.nodeType}
        </span>
      </div>

      {/* Description */}
      {data.description && !editing && (
        <p className="text-xs text-gray-400 mt-1.5 leading-snug">{data.description}</p>
      )}

      {/* Source "+" handle — appears on hover, styled as a connect button */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          width: 22, height: 22,
          borderRadius: '50%',
          backgroundColor: 'white',
          border: '2px solid #60a5fa',
          backgroundImage: PLUS_SVG,
          backgroundSize: '10px 10px',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          bottom: -11,
          transform: 'translateX(-50%)',
          cursor: 'crosshair',
          boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
        }}
      />
    </div>
  );
}

export const nodeTypes = {
  start: WorkflowNode,
  task: WorkflowNode,
  decision: WorkflowNode,
};
