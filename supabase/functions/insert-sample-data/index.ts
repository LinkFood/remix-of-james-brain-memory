import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      throw new Error('Not authenticated');
    }

    const userId = user.id;

    // Create sample conversations
    const conversations = [
      { title: 'Project Planning Discussion', created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
      { title: 'Technical Architecture Review', created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
      { title: 'Product Strategy Brainstorm', created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
      { title: 'Code Review & Optimization', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() },
    ];

    const insertedConversations = [];
    for (const conv of conversations) {
      const { data, error } = await supabaseClient
        .from('conversations')
        .insert({ user_id: userId, ...conv })
        .select()
        .single();
      
      if (error) throw error;
      insertedConversations.push(data);
    }

    // Sample messages for each conversation
    const messageTemplates = [
      // Conversation 1: Project Planning
      [
        { role: 'user', content: 'Can you help me plan out the roadmap for our new feature?', topic: 'Project Planning', importance_score: 8 },
        { role: 'assistant', content: 'I\'d be happy to help with your feature roadmap. Let\'s break it down into phases: discovery, design, development, and launch.', topic: 'Project Planning', importance_score: 7 },
        { role: 'user', content: 'What should we prioritize in the discovery phase?', topic: 'Requirements Gathering', importance_score: 9 },
        { role: 'assistant', content: 'Focus on user research, competitive analysis, and defining clear success metrics. These will guide all subsequent decisions.', topic: 'Requirements Gathering', importance_score: 8 },
      ],
      // Conversation 2: Technical Architecture
      [
        { role: 'user', content: 'We need to scale our database architecture. What are the best approaches?', topic: 'Database Scaling', importance_score: 10 },
        { role: 'assistant', content: 'For database scaling, consider read replicas, connection pooling, and implementing caching layers like Redis.', topic: 'Database Scaling', importance_score: 9 },
        { role: 'user', content: 'Should we use horizontal or vertical scaling?', topic: 'Infrastructure', importance_score: 8 },
        { role: 'assistant', content: 'Start with vertical scaling for simplicity, but design for horizontal scaling to handle future growth efficiently.', topic: 'Infrastructure', importance_score: 7 },
        { role: 'user', content: 'What about implementing a CDN for static assets?', topic: 'Performance Optimization', importance_score: 7 },
        { role: 'assistant', content: 'Absolutely! A CDN will significantly reduce latency and bandwidth costs for global users.', topic: 'Performance Optimization', importance_score: 6 },
      ],
      // Conversation 3: Product Strategy
      [
        { role: 'user', content: 'How should we position our product against competitors?', topic: 'Product Strategy', importance_score: 9 },
        { role: 'assistant', content: 'Focus on your unique value proposition. Identify gaps in competitor offerings and emphasize your strengths.', topic: 'Product Strategy', importance_score: 8 },
        { role: 'user', content: 'What metrics should we track for product-market fit?', topic: 'Metrics & Analytics', importance_score: 10 },
        { role: 'assistant', content: 'Track retention rate, NPS score, activation rate, and time-to-value. These indicate real product-market fit.', topic: 'Metrics & Analytics', importance_score: 9 },
      ],
      // Conversation 4: Code Review
      [
        { role: 'user', content: 'Can you review this React component for performance issues?', topic: 'Code Review', importance_score: 7 },
        { role: 'assistant', content: 'I see several optimization opportunities: memoize expensive calculations, use useCallback for event handlers, and implement virtualization for long lists.', topic: 'Code Review', importance_score: 8 },
        { role: 'user', content: 'Should we refactor this into smaller components?', topic: 'Code Architecture', importance_score: 6 },
        { role: 'assistant', content: 'Yes, break it into focused components with single responsibilities. This improves testability and reusability.', topic: 'Code Architecture', importance_score: 7 },
        { role: 'user', content: 'What about adding unit tests?', topic: 'Testing', importance_score: 8 },
        { role: 'assistant', content: 'Definitely. Start with critical business logic and user interactions. Aim for 80% coverage on key paths.', topic: 'Testing', importance_score: 7 },
        { role: 'user', content: 'Any security concerns I should address?', topic: 'Security', importance_score: 10 },
        { role: 'assistant', content: 'Validate all user inputs, implement proper authentication checks, and sanitize data before rendering to prevent XSS attacks.', topic: 'Security', importance_score: 9 },
      ],
    ];

    // Insert messages for each conversation
    for (let i = 0; i < insertedConversations.length; i++) {
      const conversation = insertedConversations[i];
      const messages = messageTemplates[i];
      
      for (let j = 0; j < messages.length; j++) {
        const message = messages[j];
        const messageDate = new Date(conversation.created_at);
        messageDate.setHours(messageDate.getHours() + j);
        
        const { error } = await supabaseClient
          .from('messages')
          .insert({
            conversation_id: conversation.id,
            user_id: userId,
            role: message.role,
            content: message.content,
            topic: message.topic,
            importance_score: message.importance_score,
            created_at: messageDate.toISOString(),
            model_used: message.role === 'assistant' ? 'gpt-4' : null,
            provider: message.role === 'assistant' ? 'openai' : null,
          });
        
        if (error) throw error;
      }
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Sample data inserted successfully' }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error inserting sample data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
