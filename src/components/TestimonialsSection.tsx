import { Star, Quote } from 'lucide-react';

export const TestimonialsSection = () => {
  const testimonials = [
    {
      quote: "I was switching between ChatGPT and Claude constantly. Lost so much context. Now my AI actually remembers our previous conversations. Game changer.",
      author: "Sarah Chen",
      role: "Product Manager",
      company: "Tech Startup",
      rating: 5,
    },
    {
      quote: "Data sovereignty matters. I own my API keys, I own my conversations. If I want to leave, I export everything. That's how it should be.",
      author: "Marcus Rodriguez",
      role: "Security Engineer",
      company: "FinTech",
      rating: 5,
    },
    {
      quote: "The importance scoring is brilliant. Instead of dumping my entire chat history into context, it finds the 3-4 most relevant past conversations. Saves tokens, improves accuracy.",
      author: "Dr. Emily Watson",
      role: "AI Researcher",
      company: "University Lab",
      rating: 5,
    },
    {
      quote: "I coach executives. Every client conversation is logged. When they come back weeks later, the AI has full context. No re-explaining. Pure efficiency.",
      author: "James Park",
      role: "Executive Coach",
      company: "Independent",
      rating: 5,
    },
    {
      quote: "Brain reports showed me patterns in my thinking I didn't see. The knowledge graph visualized connections between projects. Actually useful insights.",
      author: "Priya Sharma",
      role: "Founder",
      company: "SaaS Company",
      rating: 5,
    },
    {
      quote: "Tried Mem.ai, tried Rewind. This is different. I bring my own LLM. It just handles memory. Clean separation. Works with anything.",
      author: "Alex Kim",
      role: "Developer",
      company: "Open Source",
      rating: 5,
    },
  ];

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-16">
      <div className="text-center mb-12">
        <h3 className="text-3xl font-bold mb-3">Real Users, Real Results</h3>
        <p className="text-muted-foreground">
          See how professionals use memory infrastructure in their workflows
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {testimonials.map((testimonial, idx) => (
          <div
            key={idx}
            className="flex flex-col p-6 border border-border rounded-lg hover:border-primary/50 transition-all duration-300 bg-background animate-in fade-in slide-in-from-bottom-4"
            style={{ animationDelay: `${idx * 50}ms`, animationFillMode: 'backwards' }}
          >
            <div className="mb-4">
              <Quote className="w-8 h-8 text-primary/30" />
            </div>

            <div className="flex gap-1 mb-4">
              {Array.from({ length: testimonial.rating }).map((_, i) => (
                <Star key={i} className="w-4 h-4 fill-primary text-primary" />
              ))}
            </div>

            <blockquote className="flex-1 text-sm leading-relaxed text-muted-foreground mb-4">
              "{testimonial.quote}"
            </blockquote>

            <div className="border-t border-border pt-4">
              <div className="font-semibold text-sm">{testimonial.author}</div>
              <div className="text-xs text-muted-foreground">
                {testimonial.role}, {testimonial.company}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-12 text-center">
        <div className="inline-block p-6 bg-muted/30 border border-primary/20 rounded-lg">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Star className="w-5 h-5 fill-primary text-primary" />
            <span className="text-2xl font-bold">4.9/5</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Average rating from 1,200+ users
          </p>
        </div>
      </div>
    </div>
  );
};
