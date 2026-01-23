import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { apiKey, provider } = await req.json();

    if (!apiKey || !provider) {
      return new Response(
        JSON.stringify({ valid: false, error: "Missing API key or provider" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let isValid = false;
    let errorMessage = "";

    switch (provider) {
      case "openai": {
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        isValid = response.ok;
        if (!isValid) {
          const data = await response.json().catch(() => ({}));
          errorMessage = data.error?.message || "Invalid OpenAI API key";
        }
        break;
      }

      case "anthropic": {
        console.log("Testing Anthropic key, length:", apiKey.length);
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-3-haiku-20240307",
            max_tokens: 1,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });
        
        const responseText = await response.text();
        console.log("Anthropic response status:", response.status);
        console.log("Anthropic response body:", responseText);
        
        let data: any = {};
        try { data = JSON.parse(responseText); } catch {}
        
        // Anthropic returns 200 for valid keys, 401 for invalid
        if (response.status === 401) {
          errorMessage = data.error?.message || "Invalid API key - check it's still active in Anthropic console";
          isValid = false;
        } else if (response.ok || response.status === 400) {
          // 400 means key is valid but request was bad (still validates the key)
          isValid = true;
        } else {
          errorMessage = data.error?.message || `Unexpected response: ${response.status}`;
          isValid = false;
        }
        break;
      }

      case "google": {
        // Test Gemini API with a simple request
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        isValid = response.ok;
        if (!isValid) {
          const data = await response.json().catch(() => ({}));
          errorMessage = data.error?.message || "Invalid Google API key";
        }
        break;
      }

      default:
        return new Response(
          JSON.stringify({ valid: false, error: `Unknown provider: ${provider}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(
      JSON.stringify({ valid: isValid, error: isValid ? null : errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Validation error:", error);
    return new Response(
      JSON.stringify({ valid: false, error: "Failed to validate API key" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});