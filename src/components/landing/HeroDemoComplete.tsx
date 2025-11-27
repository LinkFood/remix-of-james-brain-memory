export const HeroDemoComplete = () => {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 h-full flex flex-col justify-center animate-fade-in">
      <div className="space-y-6">
        <div className="space-y-3">
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-tight">
            You've seen the proof.
            <br />
            <span className="text-primary">Now build your memory.</span>
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground font-light max-w-2xl">
            That was our demo AI. Connect your own API keys and every future conversation builds on what came before.
          </p>
        </div>
        
        <div className="grid sm:grid-cols-2 gap-4 pt-2">
          <div className="space-y-2 p-4 rounded-lg bg-muted/30 border border-border/50">
            <h3 className="font-semibold text-sm">Your AI, Your Choice</h3>
            <p className="text-xs text-muted-foreground">Use GPT-4, Claude, Gemini, or any model. Your API keys, your costs, your control.</p>
          </div>
          <div className="space-y-2 p-4 rounded-lg bg-muted/30 border border-border/50">
            <h3 className="font-semibold text-sm">Memory That Compounds</h3>
            <p className="text-xs text-muted-foreground">Every conversation enhances the next. Past context travels across all platforms.</p>
          </div>
          <div className="space-y-2 p-4 rounded-lg bg-muted/30 border border-border/50">
            <h3 className="font-semibold text-sm">Full Data Ownership</h3>
            <p className="text-xs text-muted-foreground">Export everything, anytime. Your data lives in your account, not locked in silos.</p>
          </div>
          <div className="space-y-2 p-4 rounded-lg bg-muted/30 border border-border/50">
            <h3 className="font-semibold text-sm">Works Everywhere</h3>
            <p className="text-xs text-muted-foreground">One memory layer across all your AI chats. Finally, context that follows you.</p>
          </div>
        </div>

        <div className="pt-4">
          <p className="text-sm text-primary/80 font-medium">
            Demo complete. Ready to make it permanent?
          </p>
        </div>
      </div>
    </div>
  );
};
