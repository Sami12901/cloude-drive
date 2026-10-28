import type { SVGProps } from 'react';

/**
 * Inline SVG icon set.
 *
 * Everything is drawn with `currentColor` (brand marks are the exception and use
 * fixed brand colours). No emoji, no icon fonts, no remote assets — the app works
 * offline and the icons scale cleanly at every DPI.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const DashboardIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Base>
);

export const CloudIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M7 18h9.5a3.5 3.5 0 0 0 .3-6.99A5.5 5.5 0 0 0 6.4 10.2A3.9 3.9 0 0 0 7 18Z" />
  </Base>
);

export const DriveIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M6 9h8" />
    <path d="M6 12.5h5" />
    <circle cx="17" cy="15" r="1.4" />
  </Base>
);

export const TransferIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 8h13l-3-3" />
    <path d="M20 16H7l3 3" />
  </Base>
);

export const OfflineIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3v10" />
    <path d="M8 10l4 4 4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Base>
);

export const SettingsIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
  </Base>
);

export const DiagnosticsIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 12h3l2-5 3 10 2.5-7 1.5 4h6" />
  </Base>
);

export const PlusIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const PlayIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none" />
  </Base>
);

export const StopIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Base>
);

export const RefreshIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Base>
);

export const TrashIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7l1 13h10l1-13" />
  </Base>
);

export const FolderIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Base>
);

export const FileIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </Base>
);

export const CheckIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Base>
);

export const AlertIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 4l8.5 15H3.5z" />
    <path d="M12 10v4" />
    <path d="M12 17h.01" />
  </Base>
);

export const CloseIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Base>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M9 5l7 7-7 7" />
  </Base>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M5 9l7 7 7-7" />
  </Base>
);

export const ExternalLinkIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8 8" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Base>
);

export const ShieldIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3l7 3v6c0 4.2-2.8 7.6-7 9-4.2-1.4-7-4.8-7-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Base>
);

export const InfoIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Base>
);

export const SpinnerIcon = ({ size = 20, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    aria-hidden="true"
    className="animate-spin"
    {...rest}
  >
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

export const GoogleDriveIcon = ({ size = 24, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
    <path d="M8.2 3h7.6l6.2 10.7h-7.6z" fill="#0f9d58" />
    <path d="M8.2 3 2 13.7l3.1 5.4L15.8 8.4z" fill="#fbbc04" />
    <path d="M5.1 19.1h13.8l3.1-5.4H8.2z" fill="#4285f4" />
  </svg>
);

export const OneDriveIcon = ({ size = 24, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
    <path
      d="M7 9.5a4 4 0 0 1 7.7-1.4A3.4 3.4 0 0 1 20 11.4a3.6 3.6 0 0 1-.6 7.1H7.6A4.1 4.1 0 0 1 7 9.5Z"
      fill="#0364b8"
    />
    <path d="M9 13.5h7l-2.5 3h-5z" fill="#ffffff" opacity="0.9" />
  </svg>
);

export const DropboxIcon = ({ size = 24, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
    <path d="M6 3l6 4 6-4-6-3z" fill="#0061ff" />
    <path d="M6 13l6 4 6-4-6-3z" fill="#0061ff" />
    <path d="M18 8l-6 4-6-4-1.5 2.5L12 15l7.5-4.5z" fill="#0078ff" />
  </svg>
);

export const WebDavIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="11" width="18" height="5" rx="1.5" />
    <path d="M6 6.5h.01M6 13.5h.01" />
    <path d="M3 19h18" />
  </Base>
);

export const S3Icon = (props: IconProps) => (
  <Base {...props}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
    <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
  </Base>
);

export const LocalIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M2 20h20" />
    <path d="M7 8h6" />
  </Base>
);

export const providerIcon = (providerId: string, size = 24) => {
  switch (providerId) {
    case 'gdrive':
      return <GoogleDriveIcon size={size} />;
    case 'onedrive':
      return <OneDriveIcon size={size} />;
    case 'dropbox':
      return <DropboxIcon size={size} />;
    case 'webdav':
      return <WebDavIcon size={size} />;
    case 's3':
      return <S3Icon size={size} />;
    default:
      return <LocalIcon size={size} />;
  }
};
