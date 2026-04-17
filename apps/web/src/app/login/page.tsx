import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { uid?: string };
}) {
  const uid = parseInt(searchParams.uid ?? "", 10);
  if (Number.isFinite(uid) && uid > 0) {
    cookies().set("uid", String(uid), {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  redirect("/docs/1");
}
