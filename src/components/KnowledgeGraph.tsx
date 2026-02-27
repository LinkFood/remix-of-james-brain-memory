import { useEffect, useRef, useState, useMemo, Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Network, ZoomIn, ZoomOut, RotateCcw, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Html } from '@react-three/drei';
import * as THREE from 'three';

interface Entry {
  id: string;
  title: string | null;
  content_type: string;
  tags: string[] | null;
  importance_score: number | null;
  created_at: string;
}

interface GraphNode {
  id: string;
  label: string;
  type: 'tag' | 'content_type';
  size: number;
  color: string;
  position: [number, number, number];
  connections: string[];
  count: number;
}

interface GraphEdge {
  source: string;
  target: string;
  strength: number;
}

interface KnowledgeGraphProps {
  userId: string;
}

const contentTypeColors: Record<string, string> = {
  code: '#10b981',
  list: '#f59e0b',
  idea: '#8b5cf6',
  link: '#3b82f6',
  contact: '#ec4899',
  event: '#14b8a6',
  reminder: '#ef4444',
  note: '#6b7280',
};

interface NodeProps {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  isSelected: boolean;
}

const Node = ({ node, onClick, isSelected }: NodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.005;
      if (hovered || isSelected) {
        meshRef.current.scale.lerp(new THREE.Vector3(1.3, 1.3, 1.3), 0.1);
      } else {
        meshRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
      }
    }
  });

  return (
    <group position={node.position}>
      <mesh
        ref={meshRef}
        onClick={() => onClick(node)}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        {node.type === 'tag' ? (
          <icosahedronGeometry args={[node.size, 1]} />
        ) : (
          <sphereGeometry args={[node.size, 16, 16]} />
        )}
        <meshStandardMaterial
          color={node.color}
          emissive={hovered || isSelected ? node.color : '#000000'}
          emissiveIntensity={hovered || isSelected ? 0.5 : 0}
          metalness={0.3}
          roughness={0.4}
        />
      </mesh>
      {(hovered || isSelected) && (
        <Html distanceFactor={10}>
          <div className="bg-card border border-border px-3 py-2 rounded-lg shadow-lg pointer-events-none whitespace-nowrap">
            <p className="text-xs font-semibold text-foreground">{node.label}</p>
            <p className="text-xs text-muted-foreground">{node.type} • {node.count} entries</p>
          </div>
        </Html>
      )}
    </group>
  );
};

const Edge = ({ start, end, strength }: { start: [number, number, number]; end: [number, number, number]; strength: number }) => {
  const lineRef = useRef<THREE.Line | null>(null);

  const line = useMemo(() => {
    const points = [new THREE.Vector3(...start), new THREE.Vector3(...end)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: '#6366f1',
      transparent: true,
      opacity: strength * 0.5,
    });
    return new THREE.Line(geometry, material);
  }, [start, end, strength]);

  useEffect(() => {
    lineRef.current = line;
    return () => {
      // Dispose geometry and material on unmount
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    };
  }, [line]);

  return <primitive object={line} />;
};

const Scene = ({ nodes, edges, selectedNode, onNodeClick }: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNode: GraphNode | null;
  onNodeClick: (node: GraphNode) => void;
}) => {
  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1} />
      <pointLight position={[-10, -10, -10]} intensity={0.5} />
      
      {edges.map((edge, index) => {
        const sourceNode = nodes.find(n => n.id === edge.source);
        const targetNode = nodes.find(n => n.id === edge.target);
        if (!sourceNode || !targetNode) return null;
        return (
          <Edge
            key={`edge-${index}`}
            start={sourceNode.position}
            end={targetNode.position}
            strength={edge.strength}
          />
        );
      })}

      {nodes.map((node) => (
        <Node
          key={node.id}
          node={node}
          onClick={onNodeClick}
          isSelected={selectedNode?.id === node.id}
        />
      ))}

      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        minDistance={5}
        maxDistance={50}
      />
    </>
  );
};

export default function KnowledgeGraph({ userId }: KnowledgeGraphProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  useEffect(() => {
    fetchEntries();
  }, [userId]);

  async function fetchEntries() {
    setLoading(true);
    const { data, error } = await supabase
      .from('entries')
      .select('id, title, content_type, tags, importance_score, created_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('Error fetching entries:', error);
    } else {
      setEntries(data || []);
    }
    setLoading(false);
  }

  const { nodes, edges, stats } = useMemo(() => {
    const graphNodes: GraphNode[] = [];
    const graphEdges: GraphEdge[] = [];

    // Create content type nodes
    const contentTypeCounts: Record<string, number> = {};
    entries.forEach(e => {
      contentTypeCounts[e.content_type] = (contentTypeCounts[e.content_type] || 0) + 1;
    });

    // Add content type nodes in outer ring
    const contentTypeEntries = Object.entries(contentTypeCounts);
    const typeRadius = 15;
    contentTypeEntries.forEach(([type, count], index) => {
      const angle = (index / contentTypeEntries.length) * Math.PI * 2;
      const x = Math.cos(angle) * typeRadius;
      const z = Math.sin(angle) * typeRadius;
      
      graphNodes.push({
        id: `type:${type}`,
        label: type,
        type: 'content_type',
        size: Math.min(0.5 + count * 0.15, 2.5),
        color: contentTypeColors[type] || '#6b7280',
        position: [x, 0, z],
        connections: [],
        count,
      });
    });

    // Create tag nodes and edges
    const tagCounts: Record<string, number> = {};
    const tagToTypes: Record<string, Set<string>> = {};
    
    entries.forEach(entry => {
      const tags = entry.tags || [];
      tags.forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        if (!tagToTypes[tag]) tagToTypes[tag] = new Set();
        tagToTypes[tag].add(entry.content_type);
      });

      // Create edges between tags that appear together
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const edgeKey = [tags[i], tags[j]].sort().join('|');
          const existing = graphEdges.find(e => 
            (e.source === `tag:${tags[i]}` && e.target === `tag:${tags[j]}`) ||
            (e.source === `tag:${tags[j]}` && e.target === `tag:${tags[i]}`)
          );
          if (existing) {
            existing.strength = Math.min(existing.strength + 0.1, 1);
          } else {
            graphEdges.push({
              source: `tag:${tags[i]}`,
              target: `tag:${tags[j]}`,
              strength: 0.3,
            });
          }
        }
      }
    });

    // Add top tags as nodes in inner ring
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25);

    const tagRadius = 8;
    topTags.forEach(([tag, count], index) => {
      const types = Array.from(tagToTypes[tag] || []);
      const primaryType = types[0] || 'note';
      const angle = (index / topTags.length) * Math.PI * 2;
      const x = Math.cos(angle) * tagRadius;
      const z = Math.sin(angle) * tagRadius;
      const y = (Math.random() - 0.5) * 4;

      graphNodes.push({
        id: `tag:${tag}`,
        label: tag,
        type: 'tag',
        size: Math.min(0.3 + count * 0.2, 1.8),
        color: contentTypeColors[primaryType] || '#6b7280',
        position: [x, y, z],
        connections: types,
        count,
      });

      // Connect tag to content types
      types.forEach(type => {
        graphEdges.push({
          source: `tag:${tag}`,
          target: `type:${type}`,
          strength: 0.4,
        });
      });
    });

    return {
      nodes: graphNodes,
      edges: graphEdges,
      stats: { tags: topTags.length, contentTypes: contentTypeEntries.length, connections: graphEdges.length },
    };
  }, [entries]);

  const handleNodeClick = (node: GraphNode) => {
    setSelectedNode(node);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[600px]" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Network className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-bold">Knowledge Graph</h2>
        </div>
        <Card className="h-[400px] flex flex-col items-center justify-center text-muted-foreground">
          <Network className="h-12 w-12 mb-4 opacity-50" />
          <p>No entries yet. Start dumping to build your knowledge graph!</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-bold">Knowledge Graph</h2>
        </div>
        <Button onClick={fetchEntries} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Tags</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{stats.tags}</div>
            <p className="text-xs text-muted-foreground">Unique tags</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Content Types</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-accent">{stats.contentTypes}</div>
            <p className="text-xs text-muted-foreground">Different types</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-secondary">{stats.connections}</div>
            <p className="text-xs text-muted-foreground">Tag-type links</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Interactive 3D Graph</CardTitle>
          <CardDescription>
            Spheres are content types, polyhedra are tags. Click and drag to explore.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative w-full h-[600px] bg-gradient-to-b from-background to-muted/20 rounded-lg overflow-hidden border border-border">
            <Canvas camera={{ position: [0, 10, 25], fov: 60 }}>
              <Suspense fallback={null}>
                <Scene
                  nodes={nodes}
                  edges={edges}
                  selectedNode={selectedNode}
                  onNodeClick={handleNodeClick}
                />
              </Suspense>
            </Canvas>
          </div>

          {selectedNode && (
            <Card className="mt-4 bg-card/50 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="text-base">{selectedNode.label}</CardTitle>
                <CardDescription>
                  Type: {selectedNode.type} • {selectedNode.count} entries
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(contentTypeColors).map(([type, color]) => (
              <div key={type} className="flex items-center gap-1 text-xs">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-muted-foreground">{type}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 p-4 bg-muted/50 rounded-lg">
            <p className="text-sm text-muted-foreground">
              <strong>Controls:</strong> Left click + drag to rotate • Right click + drag to pan • Scroll to zoom • Click nodes for details
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
