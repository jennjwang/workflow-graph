// Voice transcription client for the validation studies. Self-contained (the
// validation app shares no runtime with the interview app), but hits the same
// shared server endpoint /api/transcribe (gpt-4o-mini-transcribe by default).
export async function transcribeAudio(blob: Blob): Promise<string> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: base64, mimeType: blob.type }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.text as string;
}
