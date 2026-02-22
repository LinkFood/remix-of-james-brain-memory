export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      agent_conversations: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          task_ids: string[] | null
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          role: string
          task_ids?: string[] | null
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          role?: string
          task_ids?: string[] | null
          user_id?: string
        }
        Relationships: []
      }
      agent_tasks: {
        Row: {
          agent: string | null
          completed_at: string | null
          cost_usd: number | null
          created_at: string
          cron_active: boolean | null
          cron_expression: string | null
          error: string | null
          id: string
          input: Json
          intent: string
          next_run_at: string | null
          output: Json | null
          parent_task_id: string | null
          slack_notified: boolean | null
          status: string
          tokens_in: number | null
          tokens_out: number | null
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          cron_active?: boolean | null
          cron_expression?: string | null
          error?: string | null
          id?: string
          input?: Json
          intent: string
          next_run_at?: string | null
          output?: Json | null
          parent_task_id?: string | null
          slack_notified?: boolean | null
          status?: string
          tokens_in?: number | null
          tokens_out?: number | null
          type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          cron_active?: boolean | null
          cron_expression?: string | null
          error?: string | null
          id?: string
          input?: Json
          intent?: string
          next_run_at?: string | null
          output?: Json | null
          parent_task_id?: string | null
          slack_notified?: boolean | null
          status?: string
          tokens_in?: number | null
          tokens_out?: number | null
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "agent_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      brain_reports: {
        Row: {
          conversation_stats: Json | null
          created_at: string
          decisions: Json | null
          end_date: string
          id: string
          insights: Json | null
          key_themes: Json | null
          report_type: string
          start_date: string
          summary: string
          user_id: string
        }
        Insert: {
          conversation_stats?: Json | null
          created_at?: string
          decisions?: Json | null
          end_date: string
          id?: string
          insights?: Json | null
          key_themes?: Json | null
          report_type: string
          start_date: string
          summary: string
          user_id: string
        }
        Update: {
          conversation_stats?: Json | null
          created_at?: string
          decisions?: Json | null
          end_date?: string
          id?: string
          insights?: Json | null
          key_themes?: Json | null
          report_type?: string
          start_date?: string
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      entries: {
        Row: {
          archived: boolean
          content: string
          content_subtype: string | null
          content_type: string
          created_at: string
          embedding: string | null
          event_date: string | null
          event_time: string | null
          extracted_data: Json | null
          id: string
          image_url: string | null
          importance_score: number | null
          is_recurring: boolean | null
          list_items: Json | null
          recurrence_pattern: string | null
          reminder_minutes: number | null
          source: string
          starred: boolean
          tags: string[] | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived?: boolean
          content: string
          content_subtype?: string | null
          content_type?: string
          created_at?: string
          embedding?: string | null
          event_date?: string | null
          event_time?: string | null
          extracted_data?: Json | null
          id?: string
          image_url?: string | null
          importance_score?: number | null
          is_recurring?: boolean | null
          list_items?: Json | null
          recurrence_pattern?: string | null
          reminder_minutes?: number | null
          source?: string
          starred?: boolean
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived?: boolean
          content?: string
          content_subtype?: string | null
          content_type?: string
          created_at?: string
          embedding?: string | null
          event_date?: string | null
          event_time?: string | null
          extracted_data?: Json | null
          id?: string
          image_url?: string | null
          importance_score?: number | null
          is_recurring?: boolean | null
          list_items?: Json | null
          recurrence_pattern?: string | null
          reminder_minutes?: number | null
          source?: string
          starred?: boolean
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          onboarding_completed: boolean | null
          updated_at: string
          username: string | null
        }
        Insert: {
          created_at?: string
          id: string
          onboarding_completed?: boolean | null
          updated_at?: string
          username?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          onboarding_completed?: boolean | null
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          billing_cycle_start: string
          created_at: string
          id: string
          monthly_dump_count: number
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tier: string
          updated_at: string
          user_id: string
        }
        Insert: {
          billing_cycle_start?: string
          created_at?: string
          id?: string
          monthly_dump_count?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          billing_cycle_start?: string
          created_at?: string
          id?: string
          monthly_dump_count?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_settings: {
        Row: {
          created_at: string
          daily_task_limit: number | null
          id: string
          max_concurrent_tasks: number | null
          preferred_model: string | null
          settings: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_task_limit?: number | null
          id?: string
          max_concurrent_tasks?: number | null
          preferred_model?: string | null
          settings?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          daily_task_limit?: number | null
          id?: string
          max_concurrent_tasks?: number | null
          preferred_model?: string | null
          settings?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      search_entries_by_embedding: {
        Args: {
          filter_user_id: string
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          content: string
          content_subtype: string
          content_type: string
          created_at: string
          extracted_data: Json
          id: string
          importance_score: number
          list_items: Json
          similarity: number
          starred: boolean
          tags: string[]
          title: string
        }[]
      }
      search_messages_by_embedding: {
        Args: {
          filter_user_id: string
          match_count: number
          match_threshold: number
          query_embedding: string
        }
        Returns: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
          similarity: number
          topic: string
        }[]
      }
    }
    Enums: {
      message_role: "user" | "assistant" | "system"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      message_role: ["user", "assistant", "system"],
    },
  },
} as const
