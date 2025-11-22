import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Upload, FileJson, AlertCircle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";

interface ImportDataProps {
  userId: string;
  onImportComplete: () => void;
}

const ImportData = ({ userId, onImportComplete }: ImportDataProps) => {
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [open, setOpen] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const validateData = (data: any): boolean => {
    const errors: string[] = [];

    if (!Array.isArray(data.conversations)) {
      errors.push("Invalid format: 'conversations' must be an array");
    }

    if (!Array.isArray(data.messages)) {
      errors.push("Invalid format: 'messages' must be an array");
    }

    if (data.conversations) {
      data.conversations.forEach((conv: any, i: number) => {
        if (!conv.title || typeof conv.title !== 'string') {
          errors.push(`Conversation ${i + 1}: missing or invalid title`);
        }
      });
    }

    if (data.messages) {
      data.messages.forEach((msg: any, i: number) => {
        if (!msg.content || typeof msg.content !== 'string') {
          errors.push(`Message ${i + 1}: missing or invalid content`);
        }
        if (!msg.role || !['user', 'assistant', 'system'].includes(msg.role)) {
          errors.push(`Message ${i + 1}: invalid role (must be user, assistant, or system)`);
        }
        if (!msg.conversation_id) {
          errors.push(`Message ${i + 1}: missing conversation_id`);
        }
      });
    }

    setValidationErrors(errors);
    return errors.length === 0;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/json') {
      toast.error("Please upload a JSON file");
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        
        if (!validateData(data)) {
          toast.error("Validation failed. Please check the errors below.");
          return;
        }

        await importData(data);
      } catch (error: any) {
        toast.error("Invalid JSON file");
        console.error(error);
      }
    };
    reader.readAsText(file);
  };

  const importData = async (data: any) => {
    setImporting(true);
    setProgress(0);

    try {
      const totalSteps = (data.conversations?.length || 0) + (data.messages?.length || 0);
      let completed = 0;

      // Import conversations
      if (data.conversations && data.conversations.length > 0) {
        const conversationsWithUserId = data.conversations.map((conv: any) => ({
          ...conv,
          user_id: userId,
          id: conv.id || undefined, // Let Supabase generate if not provided
        }));

        const { error: convError } = await supabase
          .from('conversations')
          .insert(conversationsWithUserId);

        if (convError) throw convError;
        
        completed += data.conversations.length;
        setProgress((completed / totalSteps) * 100);
      }

      // Import messages in batches
      if (data.messages && data.messages.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < data.messages.length; i += batchSize) {
          const batch = data.messages.slice(i, i + batchSize);
          const messagesWithUserId = batch.map((msg: any) => ({
            ...msg,
            user_id: userId,
            id: msg.id || undefined,
          }));

          const { error: msgError } = await supabase
            .from('messages')
            .insert(messagesWithUserId);

          if (msgError) throw msgError;

          completed += batch.length;
          setProgress((completed / totalSteps) * 100);
        }
      }

      toast.success(`Successfully imported ${data.conversations?.length || 0} conversations and ${data.messages?.length || 0} messages`);
      setOpen(false);
      onImportComplete();
    } catch (error: any) {
      toast.error(`Import failed: ${error.message}`);
      console.error(error);
    } finally {
      setImporting(false);
      setProgress(0);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Upload className="w-4 h-4" />
          Import Data
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="w-5 h-5 text-primary" />
            Import Data
          </DialogTitle>
          <DialogDescription>
            Upload a JSON file to import conversations and messages
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {validationErrors.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <p className="font-semibold mb-2">Validation Errors:</p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  {validationErrors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="text-sm">Expected Format</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs bg-muted p-3 rounded overflow-x-auto">
{`{
  "conversations": [{
    "id": "uuid",
    "title": "Conversation Title",
    "created_at": "2024-01-01T00:00:00Z"
  }],
  "messages": [{
    "conversation_id": "uuid",
    "role": "user|assistant|system",
    "content": "Message text",
    "created_at": "2024-01-01T00:00:00Z"
  }]
}`}
              </pre>
            </CardContent>
          </Card>

          {importing ? (
            <div className="space-y-2">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-primary animate-pulse" />
                Importing data...
              </div>
              <Progress value={progress} className="w-full" />
              <p className="text-xs text-center text-muted-foreground">
                {Math.round(progress)}% complete
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 py-8 border-2 border-dashed rounded-lg hover:border-primary/50 transition-colors">
              <Upload className="w-12 h-12 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium mb-1">Choose a file to import</p>
                <p className="text-xs text-muted-foreground">JSON format only</p>
              </div>
              <Button asChild variant="outline">
                <label className="cursor-pointer">
                  Select File
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </label>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ImportData;
