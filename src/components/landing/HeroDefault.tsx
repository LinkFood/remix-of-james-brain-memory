export const HeroDefault = () => {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 h-full flex flex-col justify-center animate-fade-in">
      <div className="space-y-4">
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-tight">
          Your AI conversations,
          <br />
          <span className="text-primary">finally unified</span>
        </h1>
        <p className="text-lg sm:text-xl text-muted-foreground font-light max-w-2xl">
          ChatGPT forgets what you told Claude. Claude doesn't know what you asked Gemini. 
          <span className="text-foreground font-medium"> We fix that.</span>
        </p>
        <p className="text-sm text-primary/60 font-medium">
          Try the demo below (using our AI) — sign up to connect your own.
        </p>
        <div className="grid sm:grid-cols-3 gap-3 pt-2">
          <div className="space-y-1">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">1</div>
            <h3 className="font-semibold text-sm">Use any AI</h3>
            <p className="text-xs text-muted-foreground">Your API keys. Your models.</p>
          </div>
          <div className="space-y-1">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">2</div>
            <h3 className="font-semibold text-sm">We remember everything</h3>
            <p className="text-xs text-muted-foreground">Every conversation builds your knowledge.</p>
          </div>
          <div className="space-y-1">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">3</div>
            <h3 className="font-semibold text-sm">Context travels</h3>
            <p className="text-xs text-muted-foreground">Past context enhances every chat.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
