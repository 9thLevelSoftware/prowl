"use client";

import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Button, Textarea, Card, CardBody, CardHeader } from "@/components/ui";
import { ResultMessage, useAction } from "@/components/action";
import { uploadResume } from "@/lib/actions/profile";

export function ResumeUpload({ hasProfile }: { hasProfile: boolean }) {
  const { pending, result, run } = useAction();
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [fileName, setFileName] = useState("");
  const form = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader
        title={hasProfile ? "Import a new resume" : "Start with your resume"}
        description={
          hasProfile
            ? "Importing creates a new profile version. Your current version is kept and can be restored."
            : "Upload a PDF, DOCX, or text file, or paste the text. The AI copies what's on the page; it doesn't rewrite anything at this step."
        }
        actions={
          <div className="flex rounded-md border border-border p-0.5 text-[13px]">
            {(["file", "paste"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-2 py-0.5 ${mode === m ? "bg-panel-2 font-medium" : "text-muted"}`}>
                {m === "file" ? "Upload file" : "Paste text"}
              </button>
            ))}
          </div>
        }
      />
      <CardBody>
        <form
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            run(() => uploadResume(fd), () => {
              form.current?.reset();
              setFileName("");
            });
          }}
          className="flex flex-col gap-3"
        >
          {mode === "file" ? (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center hover:border-accent/50">
              <Upload className="size-5 text-muted" />
              <span className="font-medium">{fileName || "Choose a resume file"}</span>
              <span className="text-[12px] text-muted">PDF, DOCX, TXT, or MD, up to 10 MB</span>
              <input name="resume" type="file" accept=".pdf,.docx,.txt,.md" className="sr-only" onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")} />
            </label>
          ) : (
            <Textarea name="pasted" rows={10} placeholder="Paste your full resume text here" />
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {pending ? "Reading your resume…" : "Import resume"}
            </Button>
            <ResultMessage result={result} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
