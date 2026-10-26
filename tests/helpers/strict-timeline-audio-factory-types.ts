import type {FrameService} from '../../packages/business/src/frames.ts';
import type {ImageService} from '../../packages/business/src/images.ts';
import type {ServiceResponse, ServiceResponseMap, FixtureImageTask, FixtureImageReview} from './strict-service-responses.ts';
import type {ImageTaskResponse} from '../../packages/contracts/src/images.ts';

type FrameOperation = Extract<keyof ServiceResponseMap, `frame.${string}`>;
type ImageOperation = Extract<keyof ServiceResponseMap, `image.${string}`>;
export type FrameHandlerResult<O extends string> = O extends 'frame.extract' | 'frame.task.recoverResult' ? Promise<ServiceResponse<O>> : ServiceResponse<O>;
export type ImageHandlerResult<O extends string> = O extends 'image.generate' | 'image.task.recoverResult' | 'image.review.prepare' ? ServiceResponse<O> | Promise<ServiceResponse<O>> : ServiceResponse<O>;
export type TypedFrameCall = <O extends string>(operation: O, input: unknown) => FrameHandlerResult<O>;
export type TypedImageCall = <O extends string>(operation: O, input: unknown) => ImageHandlerResult<O>;
export type TypedFrameServices = Omit<FrameService, 'handlers'> & {
  handlers: {[O in FrameOperation]: (input: unknown, context?: {signal?: AbortSignal | null}) => FrameHandlerResult<O>} & FrameService['handlers'];
};
export type TypedImageServices = Omit<ImageService, 'handlers' | 'approveReviewed' | 'rejectReview'> & {
  handlers: {[O in ImageOperation]: (input: unknown, context?: {signal?: AbortSignal | null}) => ImageHandlerResult<O>} & ImageService['handlers'];
  approveReviewed(input: unknown): FixtureImageTask | Promise<FixtureImageTask>;
  rejectReview(input:unknown): FixtureImageReview;
};

import type {createSubjectServices,createSubjectRecoveryBoundary} from '../../packages/business/src/subjects.ts';
import type {createSubjectOwnershipReader} from '../../packages/business/src/subject-ownership.ts';
import type {createOwnedMediaGraphReader} from '../../packages/business/src/inspection.ts';
import type {FrameTaskView,FrameSourceIdentity} from '../../packages/business/src/frame-ownership.ts';
import type {ImageTaskView,ImageSourceIdentity} from '../../packages/business/src/image-ownership.ts';
import type {SubjectResponse,SubjectVersionResponse} from '../../packages/contracts/src/subjects.ts';
type SubjectOperation=Extract<keyof ServiceResponseMap,`subject.${string}`>;
export type TypedSubjectServices=Omit<ReturnType<typeof createSubjectServices>,'handlers'>&{
  handlers:{[O in SubjectOperation]:(input:unknown)=>ServiceResponse<O>} & ReturnType<typeof createSubjectServices>['handlers'];
};
export type TypedSubjectBoundary=Omit<ReturnType<typeof createSubjectRecoveryBoundary>,'asset'|'subject'|'version'>&{
  asset(id:unknown):ReturnType<ReturnType<typeof createSubjectOwnershipReader>['asset']>;
  subject(id:unknown):SubjectResponse;
  version(id:unknown,subjectId?:unknown):SubjectVersionResponse;
};
export type TypedOwnedGraph=Omit<ReturnType<typeof createOwnedMediaGraphReader>,'frameTask'|'frameSource'|'imageTask'|'imageSource'>&{
  frameTask(id:unknown):FrameTaskView;
  frameSource(id:unknown):FrameSourceIdentity|null;
  imageTask(id:unknown):ImageTaskView;
  imageSource(id:unknown):ImageSourceIdentity|null;
};
