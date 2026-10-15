/** Canonical error identity shared by typed leaves and the legacy barrel.
 * Declared fields emit nothing; own fields retain constructor assignment order. */
export class AppError extends Error {
 declare code: string;
 declare status: number;
 declare details: unknown;
 constructor(code:string,message:string,status=400,details:unknown={}){super(message);this.code=code;this.status=status;this.details=details;}
}
