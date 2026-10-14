import React from "react";
import { Modal as HeroModal, useOverlayState } from "@heroui/react";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Accepted for API compatibility; dialogs render without a header glyph. */
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "xs" | "sm" | "md" | "lg";
}

/** Controlled dialog on HeroUI v3 Modal + useOverlayState. */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}) => {
  const state = useOverlayState({
    isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });

  return (
    <HeroModal state={state}>
      <HeroModal.Backdrop variant="opaque">
        <HeroModal.Container placement="center" size={size}>
          <HeroModal.Dialog>
            <HeroModal.Header>
              <div className="min-w-0 pr-8">
                <HeroModal.Heading>{title}</HeroModal.Heading>
                {description && (
                  <p className="mt-1 text-sm leading-relaxed text-muted">
                    {description}
                  </p>
                )}
              </div>
              <HeroModal.CloseTrigger />
            </HeroModal.Header>
            <HeroModal.Body className="pt-2">{children}</HeroModal.Body>
            {footer && (
              <HeroModal.Footer className="gap-2">{footer}</HeroModal.Footer>
            )}
          </HeroModal.Dialog>
        </HeroModal.Container>
      </HeroModal.Backdrop>
    </HeroModal>
  );
};
