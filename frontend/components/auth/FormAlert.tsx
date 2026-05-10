/**
 * Enhanced error/warning/success alert for auth forms
 */
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { Button } from "../ui/button";

export type AlertType = "error" | "warning" | "success" | "info";

interface FormAlertProps {
  type: AlertType;
  title?: string;
  message: string;
  details?: string[];
  onDismiss?: () => void;
}

export const FormAlert = ({
  type,
  title,
  message,
  details,
  onDismiss,
}: FormAlertProps) => {
  const variants = {
    error: {
      icon: <AlertCircle className="h-5 w-5" />,
      className: "border-red-200 bg-red-50",
      titleClassName: "text-red-900",
      descriptionClassName: "text-red-800",
      defaultTitle: "Error",
    },
    warning: {
      icon: <AlertCircle className="h-5 w-5" />,
      className: "border-yellow-200 bg-yellow-50",
      titleClassName: "text-yellow-900",
      descriptionClassName: "text-yellow-800",
      defaultTitle: "Warning",
    },
    success: {
      icon: <CheckCircle2 className="h-5 w-5" />,
      className: "border-green-200 bg-green-50",
      titleClassName: "text-green-900",
      descriptionClassName: "text-green-800",
      defaultTitle: "Success",
    },
    info: {
      icon: <Info className="h-5 w-5" />,
      className: "border-blue-200 bg-blue-50",
      titleClassName: "text-blue-900",
      descriptionClassName: "text-blue-800",
      defaultTitle: "Information",
    },
  };

  const variant = variants[type];

  return (
    <Alert className={`relative ${variant.className}`}>
      <div className="flex gap-3">
        <div className={variant.titleClassName}>{variant.icon}</div>
        <div className="flex-1">
          {(title || variant.defaultTitle) && (
            <AlertTitle className={variant.titleClassName}>
              {title || variant.defaultTitle}
            </AlertTitle>
          )}
          <AlertDescription className={variant.descriptionClassName}>
            <div className="space-y-1">
              <p>{message}</p>
              {details && details.length > 0 && (
                <ul className="list-disc list-inside text-sm mt-2 space-y-0.5">
                  {details.map((detail, idx) => (
                    <li key={idx}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDescription>
        </div>
      </div>
      {onDismiss && (
        <Button
          variant="ghost"
          onClick={onDismiss}
          className={`absolute top-3 right-3 ${variant.titleClassName} hover:opacity-70`}
        >
          ✕
        </Button>
      )}
    </Alert>
  );
};
