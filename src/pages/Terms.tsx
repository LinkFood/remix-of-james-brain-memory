import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { LinkJacLogo } from "@/components/LinkJacLogo";

const Terms = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 px-4 sm:px-6 py-4 bg-background/80 backdrop-blur-xl sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <LinkJacLogo size="md" />
          <Button onClick={() => navigate(-1)} variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-bold mb-8">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: January 25, 2026</p>

        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mb-3">1. Service Description</h2>
            <p className="text-muted-foreground leading-relaxed">
              LinkJac is an AI-powered personal knowledge management service that allows you to capture, organize, and retrieve information. By using our service, you can dump text, code, ideas, and notes which are then automatically classified, tagged, and stored using artificial intelligence.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">2. User Responsibilities</h2>
            <p className="text-muted-foreground leading-relaxed">
              You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You agree to:
            </p>
            <ul className="list-disc pl-6 text-muted-foreground space-y-2 mt-2">
              <li>Provide accurate and complete registration information</li>
              <li>Not share your account with others</li>
              <li>Not use the service for any illegal or unauthorized purpose</li>
              <li>Not upload malicious content or attempt to compromise the service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">3. Data Ownership</h2>
            <p className="text-muted-foreground leading-relaxed">
              You retain full ownership of all content you submit to LinkJac. We do not claim any intellectual property rights over your data. You grant us a limited license to process, store, and analyze your content solely for the purpose of providing the service to you.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">4. Data Export & Deletion</h2>
            <p className="text-muted-foreground leading-relaxed">
              You have the right to export all of your data at any time through the Settings page. You may also request complete deletion of your account and all associated data. Upon deletion, your data will be permanently removed from our systems within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">5. AI Processing</h2>
            <p className="text-muted-foreground leading-relaxed">
              Your content is processed by AI systems for classification, tagging, embedding generation, and importance scoring. This processing is performed to enhance your experience and enable semantic search capabilities. AI processing results are stored alongside your content and are not shared with third parties.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">6. Prohibited Uses</h2>
            <p className="text-muted-foreground leading-relaxed">
              You may not use LinkJac to:
            </p>
            <ul className="list-disc pl-6 text-muted-foreground space-y-2 mt-2">
              <li>Store or distribute illegal content</li>
              <li>Infringe on the intellectual property rights of others</li>
              <li>Harass, abuse, or harm other individuals</li>
              <li>Attempt to reverse engineer or exploit the service</li>
              <li>Automate access to the service in ways that could impair performance</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">7. Service Availability</h2>
            <p className="text-muted-foreground leading-relaxed">
              We strive to maintain high availability but do not guarantee uninterrupted access. We reserve the right to modify, suspend, or discontinue the service at any time with reasonable notice.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">8. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              LinkJac is provided "as is" without warranties of any kind. We are not liable for any indirect, incidental, or consequential damages arising from your use of the service. Our total liability shall not exceed the amount you paid for the service in the past 12 months.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">9. Changes to Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update these terms from time to time. Continued use of the service after changes constitutes acceptance of the new terms. Significant changes will be communicated via email or in-app notification.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">10. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              For questions about these Terms of Service, please contact us through the application.
            </p>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-8 px-4">
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <p>© 2026 LinkJac. All rights reserved.</p>
          <div className="flex gap-6">
            <button onClick={() => navigate('/terms')} className="hover:text-foreground transition-colors">Terms</button>
            <button onClick={() => navigate('/privacy')} className="hover:text-foreground transition-colors">Privacy</button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Terms;
