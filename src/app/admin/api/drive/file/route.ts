import { NextRequest, NextResponse } from "next/server";
import { authorizeDriveRequest } from "@/lib/driveAuth";
import {
  assertEntryUnderRoot,
  trashFile,
  DriveNotConnectedError,
  DriveOutsideRootError,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

// Move a file to Drive trash (recoverable). Containment-guarded.
export async function DELETE(req: NextRequest) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  const fileId = new URL(req.url).searchParams.get("fileId");
  if (!fileId) return NextResponse.json({ error: "missing fileId" }, { status: 400 });

  try {
    await assertEntryUnderRoot(fileId); // reject anything outside the root tree
    await trashFile(fileId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof DriveNotConnectedError) return NextResponse.json({ error: "not connected" }, { status: 409 });
    if (e instanceof DriveOutsideRootError) return NextResponse.json({ error: "file outside root" }, { status: 403 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
