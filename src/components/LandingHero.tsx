import { HeroDefault } from './landing/HeroDefault';
import { HeroAuth } from './landing/HeroAuth';
import { HeroHowItWorks } from './landing/HeroHowItWorks';
import { HeroDemoComplete } from './landing/HeroDemoComplete';

export type HeroMode = 
  | 'default'
  | 'signup'
  | 'login'
  | 'how-it-works'
  | 'demo-complete';

interface LandingHeroProps {
  mode: HeroMode;
  onModeChange: (mode: HeroMode) => void;
  onAuthSuccess: () => void;
}

export const LandingHero = ({ mode, onModeChange, onAuthSuccess }: LandingHeroProps) => {
  return (
    <div className="flex-shrink-0 h-[40vh] border-b border-border/50 bg-gradient-to-br from-background via-background to-primary/5 overflow-hidden">
      {mode === 'default' && <HeroDefault />}
      {(mode === 'signup' || mode === 'login') && (
        <HeroAuth 
          mode={mode} 
          onSuccess={onAuthSuccess} 
          onBack={() => onModeChange('default')} 
        />
      )}
      {mode === 'how-it-works' && (
        <HeroHowItWorks onBack={() => onModeChange('default')} />
      )}
      {mode === 'demo-complete' && <HeroDemoComplete />}
    </div>
  );
};
