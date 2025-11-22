import { useEffect, useState, useRef, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Html } from "@react-three/drei";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Network, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import * as THREE from "three";

interface KnowledgeGraphProps {
  userId: string;
}

interface GraphNode {
  id: string;
  label: string;
  type: "topic" | "conversation";
  size: number;
  color: string;
  position: [number, number, number];
  connections: string[];
}

interface GraphEdge {
  source: string;
  target: string;
  strength: number;
}

interface NodeProps {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  isSelected: boolean;
}

const Node = ({ node, onClick, isSelected }: NodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useFrame((state) => {
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
        {node.type === "topic" ? (
          <icosahedronGeometry args={[node.size, 1]} />
        ) : (
          <sphereGeometry args={[node.size, 16, 16]} />
        )}
        <meshStandardMaterial
          color={node.color}
          emissive={hovered || isSelected ? node.color : "#000000"}
          emissiveIntensity={hovered || isSelected ? 0.5 : 0}
          metalness={0.3}
          roughness={0.4}
        />
      </mesh>
      {(hovered || isSelected) && (
        <Html distanceFactor={10}>
          <div className="bg-card border border-border px-3 py-2 rounded-lg shadow-lg pointer-events-none whitespace-nowrap">
            <p className="text-xs font-semibold text-foreground">{node.label}</p>
            <p className="text-xs text-muted-foreground">{node.type}</p>
          </div>
        </Html>
      )}
    </group>
  );
};

const Edge = ({ start, end, strength }: { start: [number, number, number]; end: [number, number, number]; strength: number }) => {
  const points = [new THREE.Vector3(...start), new THREE.Vector3(...end)];
  const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);

  return (
    <primitive object={new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ 
      color: "#6366f1", 
      transparent: true, 
      opacity: strength * 0.5 
    }))} />
  );
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
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [stats, setStats] = useState({ topics: 0, conversations: 0, connections: 0 });

  useEffect(() => {
    if (userId) {
      fetchGraphData();
    }
  }, [userId]);

  const fetchGraphData = async () => {
    setLoading(true);
    try {
      // Fetch conversations and messages
      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select('id, title')
        .eq('user_id', userId);

      if (convError) throw convError;

      const { data: messages, error: msgError } = await supabase
        .from('messages')
        .select('conversation_id, topic')
        .eq('user_id', userId)
        .not('topic', 'is', null);

      if (msgError) throw msgError;

      // Build topic map
      const topicMap = new Map<string, Set<string>>();
      messages?.forEach(msg => {
        if (msg.topic) {
          if (!topicMap.has(msg.topic)) {
            topicMap.set(msg.topic, new Set());
          }
          topicMap.get(msg.topic)?.add(msg.conversation_id);
        }
      });

      // Create nodes
      const graphNodes: GraphNode[] = [];
      const graphEdges: GraphEdge[] = [];

      // Add topic nodes in a circular pattern
      const topicEntries = Array.from(topicMap.entries()).slice(0, 20); // Limit to 20 topics
      const topicRadius = 15;
      topicEntries.forEach(([topic, convIds], index) => {
        const angle = (index / topicEntries.length) * Math.PI * 2;
        const x = Math.cos(angle) * topicRadius;
        const z = Math.sin(angle) * topicRadius;
        const size = Math.min(0.5 + (convIds.size * 0.1), 2);

        graphNodes.push({
          id: `topic-${topic}`,
          label: topic,
          type: "topic",
          size,
          color: "#8b5cf6",
          position: [x, 0, z],
          connections: Array.from(convIds),
        });
      });

      // Add conversation nodes in inner circle
      const relevantConvs = conversations?.filter(conv => 
        messages?.some(msg => msg.conversation_id === conv.id)
      ).slice(0, 15) || [];

      const convRadius = 8;
      relevantConvs.forEach((conv, index) => {
        const angle = (index / relevantConvs.length) * Math.PI * 2;
        const x = Math.cos(angle) * convRadius;
        const z = Math.sin(angle) * convRadius;
        
        const msgCount = messages?.filter(m => m.conversation_id === conv.id).length || 0;
        const size = Math.min(0.3 + (msgCount * 0.02), 1.5);

        graphNodes.push({
          id: conv.id,
          label: conv.title || 'Untitled',
          type: "conversation",
          size,
          color: "#06b6d4",
          position: [x, Math.random() * 2 - 1, z],
          connections: [],
        });
      });

      // Create edges
      graphNodes.forEach(node => {
        if (node.type === "topic") {
          node.connections.forEach(convId => {
            if (graphNodes.find(n => n.id === convId)) {
              const strength = 0.5 + (Math.random() * 0.5);
              graphEdges.push({
                source: node.id,
                target: convId,
                strength,
              });
            }
          });
        }
      });

      setNodes(graphNodes);
      setEdges(graphEdges);
      setStats({
        topics: topicEntries.length,
        conversations: relevantConvs.length,
        connections: graphEdges.length,
      });
    } catch (error) {
      console.error('Error fetching knowledge graph data:', error);
    } finally {
      setLoading(false);
    }
  };

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-bold">Knowledge Graph</h2>
        </div>
        <div className="flex gap-2">
          <Button onClick={fetchGraphData} variant="outline" size="sm">
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Topics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{stats.topics}</div>
            <p className="text-xs text-muted-foreground">Unique topics</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Conversations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-accent">{stats.conversations}</div>
            <p className="text-xs text-muted-foreground">Connected conversations</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-secondary">{stats.connections}</div>
            <p className="text-xs text-muted-foreground">Topic-conversation links</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Interactive 3D Graph</CardTitle>
          <CardDescription>
            Purple nodes are topics, cyan nodes are conversations. Click and drag to explore.
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
                  Type: {selectedNode.type} • Connections: {selectedNode.connections.length}
                </CardDescription>
              </CardHeader>
            </Card>
          )}

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
