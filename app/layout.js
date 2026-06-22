import "./globals.css";

export const metadata = {
  title: "Yardi ETL Import Tool",
  description: "Convert a RealPage raw budget export into a Yardi-ready ETL CSV.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
