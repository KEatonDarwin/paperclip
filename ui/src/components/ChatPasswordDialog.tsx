import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { chatsApi } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";

interface SetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  chatId: string;
  isLocked: boolean;
}

export function SetPasswordDialog({
  open,
  onOpenChange,
  agentId,
  chatId,
  isLocked,
}: SetPasswordDialogProps) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const lockMutation = useMutation({
    mutationFn: () => chatsApi.lock(agentId, chatId, password),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(agentId) });
      reset();
      onOpenChange(false);
    },
    onError: () => setError("Failed to set password"),
  });

  const unlockMutation = useMutation({
    mutationFn: () => chatsApi.unlock(agentId, chatId, password),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(agentId) });
      reset();
      onOpenChange(false);
    },
    onError: () => setError("Incorrect password"),
  });

  function reset() {
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setError("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (isLocked) {
      if (!password) { setError("Enter the current password"); return; }
      unlockMutation.mutate();
    } else {
      if (!password) { setError("Enter a password"); return; }
      if (password !== confirmPassword) { setError("Passwords do not match"); return; }
      lockMutation.mutate();
    }
  }

  const isPending = lockMutation.isPending || unlockMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {isLocked ? "Remove Thread Lock" : "Lock Thread"}
          </DialogTitle>
          <DialogDescription>
            {isLocked
              ? "Enter the current password to remove the lock from this thread."
              : "Set a password to lock this thread. You'll be prompted for it every time you open it."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              placeholder={isLocked ? "Current password" : "Password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {!isLocked && (
            <Input
              type={showPassword ? "text" : "password"}
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "..." : isLocked ? "Remove Lock" : "Lock Thread"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface PasswordGateProps {
  agentId: string;
  chatId: string;
  onUnlocked: () => void;
}

export function PasswordGate({ agentId, chatId, onUnlocked }: PasswordGateProps) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const verifyMutation = useMutation({
    mutationFn: () => chatsApi.verifyPassword(agentId, chatId, password),
    onSuccess: (result) => {
      if (result.valid) {
        onUnlocked();
      } else {
        setError("Incorrect password");
        setPassword("");
      }
    },
    onError: () => setError("Verification failed"),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!password) { setError("Enter the password"); return; }
    verifyMutation.mutate();
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
          <Lock className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium">This thread is locked</h3>
        <p className="text-xs text-muted-foreground">Enter the password to view this conversation.</p>
      </div>
      <form onSubmit={handleSubmit} className="w-full max-w-xs space-y-3">
        <div className="relative">
          <Input
            type={showPassword ? "text" : "password"}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {error && <p className="text-sm text-destructive text-center">{error}</p>}
        <Button type="submit" className="w-full" disabled={verifyMutation.isPending}>
          {verifyMutation.isPending ? "Verifying..." : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
