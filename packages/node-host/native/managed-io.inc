// Opaque backup leases. No CRT descriptor, HANDLE or arbitrary Win32 entrypoint
// escapes this module; every operation retains the complete verified walk.
struct Lease {
  User user; Options opt; Tree tree; napi_env env; napi_ref metadata=nullptr;
  bool closed=false, directory=false, writable=false, writing=false, reading=false, started=false;
  uint64_t offset=0; size_t entryOffset=0,entryBytes=0; std::vector<BYTE> entries;
  Lease(napi_env e,Options o):opt(std::move(o)),env(e){}
  void close(){if(closed)return;closed=true;tree.handles.clear();if(metadata){napi_delete_reference(env,metadata);metadata=nullptr;}}
  ~Lease(){close();}
};
const napi_type_tag leaseTypeTag{0xd058de5b2bf9471cULL,0xa67d337f432b0f84ULL};
void validateLease(Lease& lease){
  check(!lease.closed,"IO_ERROR");
  for(size_t i=0;i<lease.tree.handles.size();i++){
    const bool leaf=i+1==lease.tree.handles.size();
    validate(lease.tree.handles[i].value,joinPrefix(lease.opt.path,i),lease.user,!leaf||lease.directory,i>=lease.opt.root.components.size(),i==lease.opt.root.components.size(),lease.opt.maxBytes);
  }
}
void expected(napi_env env,HANDLE handle,napi_value object){
  if(!has(env,object,"expectedVolume"))return;
  const auto volume=text(env,property(env,object,"expectedVolume")),fileId=text(env,property(env,object,"expectedFileId"));
  const auto identity=identify(handle);
  check(volume==std::wstring(identity.volume.begin(),identity.volume.end())&&fileId==std::wstring(identity.fileId.begin(),identity.fileId.end()),"FILE_CHANGED");
}
napi_value metadata(Lease& lease){
  validateLease(lease);const auto before=identify(lease.tree.leaf());napi_value callback=nullptr,result=nullptr;
  check(lease.metadata&&napi_get_reference_value(lease.env,lease.metadata,&callback)==napi_ok);
  if(napi_call_function(lease.env,undefined(lease.env),callback,0,nullptr,&result)!=napi_ok){bool pending=false;napi_is_exception_pending(lease.env,&pending);if(pending){napi_value ignored;napi_get_and_clear_last_exception(lease.env,&ignored);}reject("IO_ERROR");}
  napi_valuetype type;check(napi_typeof(lease.env,result,&type)==napi_ok&&type==napi_object);
  validateLease(lease);auto after=identify(lease.tree.leaf());check(before.volume==after.volume&&before.fileId==after.fileId,"FILE_CHANGED");
  napi_value envelope;check(napi_create_object(lease.env,&envelope)==napi_ok);set(lease.env,envelope,"metadata",result);set(lease.env,envelope,"volume",stringValue(lease.env,before.volume));set(lease.env,envelope,"fileId",stringValue(lease.env,before.fileId));return envelope;
}
Lease& leaseArgs(napi_env env,napi_callback_info info,std::vector<napi_value>& values,size_t count){
  napi_value self;size_t actual=count;values.resize(count);check(napi_get_cb_info(env,info,&actual,values.data(),&self,nullptr)==napi_ok&&actual==count);bool ownLease=false;check(napi_check_object_type_tag(env,self,&leaseTypeTag,&ownLease)==napi_ok&&ownLease);void* raw=nullptr;check(napi_unwrap(env,self,&raw)==napi_ok&&raw);return *static_cast<Lease*>(raw);
}
napi_value leaseMetadata(napi_env env,napi_callback_info info){return guarded(env,[&]{std::vector<napi_value> values;return metadata(leaseArgs(env,info,values,0));});}
napi_value leaseClose(napi_env env,napi_callback_info info){return guarded(env,[&]{std::vector<napi_value> values;leaseArgs(env,info,values,0).close();return undefined(env);});}
napi_value leaseRead(napi_env env,napi_callback_info info){return guarded(env,[&]{std::vector<napi_value> values;auto& lease=leaseArgs(env,info,values,1);check(!lease.directory&&lease.reading);validateLease(lease);uint32_t size=0;double exact=0;check(napi_get_value_uint32(env,values[0],&size)==napi_ok&&napi_get_value_double(env,values[0],&exact)==napi_ok&&size>0&&size<=1024*1024&&exact==size,"SIZE_LIMIT");
  check(lease.offset<=lease.opt.maxBytes,"SIZE_LIMIT");const auto remaining=lease.opt.maxBytes-lease.offset;auto wanted=static_cast<DWORD>(std::min<uint64_t>(size,remaining+1));std::vector<BYTE> bytes(wanted);DWORD readBytes=0;check(ReadFile(lease.tree.leaf(),bytes.data(),wanted,&readBytes,nullptr));check(readBytes<=remaining,"SIZE_LIMIT");lease.offset+=readBytes;validateLease(lease);napi_value result;check(napi_create_buffer_copy(env,readBytes,bytes.data(),nullptr,&result)==napi_ok);return result;
});}
napi_value leaseWrite(napi_env env,napi_callback_info info){return guarded(env,[&]{std::vector<napi_value> values;auto& lease=leaseArgs(env,info,values,1);check(!lease.directory&&lease.writing);validateLease(lease);void* bytes=nullptr;size_t length=0;check(napi_get_buffer_info(env,values[0],&bytes,&length)==napi_ok&&length<=1024*1024,"SIZE_LIMIT");check(lease.offset<=lease.opt.maxBytes&&length<=lease.opt.maxBytes-lease.offset,"SIZE_LIMIT");size_t offset=0;while(offset<length){DWORD written=0;check(WriteFile(lease.tree.leaf(),static_cast<BYTE*>(bytes)+offset,static_cast<DWORD>(length-offset),&written,nullptr)&&written>0);offset+=written;}lease.offset+=length;validateLease(lease);return undefined(env);});}
napi_value leaseFlush(napi_env env,napi_callback_info info){return guarded(env,[&]{std::vector<napi_value> values;auto& lease=leaseArgs(env,info,values,0);check(lease.writable);validateLease(lease);check(FlushFileBuffers(lease.tree.leaf()));validateLease(lease);return undefined(env);});}
napi_value leaseNext(napi_env env,napi_callback_info info){return guarded(env,[&]{std::vector<napi_value> values;auto& lease=leaseArgs(env,info,values,0);check(lease.directory);validateLease(lease);
  for(;;){
    if(lease.entryOffset>=lease.entryBytes){lease.entries.assign(64*1024,0);const auto kind=lease.started?FileIdBothDirectoryInfo:FileIdBothDirectoryRestartInfo;lease.started=true;
      if(!GetFileInformationByHandleEx(lease.tree.leaf(),kind,lease.entries.data(),static_cast<DWORD>(lease.entries.size()))){if(GetLastError()==ERROR_NO_MORE_FILES)return nullValue(env);reject("IO_ERROR");}lease.entryOffset=0;lease.entryBytes=lease.entries.size();}
    check(lease.entryOffset+offsetof(FILE_ID_BOTH_DIR_INFO,FileName)<=lease.entryBytes);auto entry=reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(lease.entries.data()+lease.entryOffset);const size_t recordEnd=lease.entryOffset+offsetof(FILE_ID_BOTH_DIR_INFO,FileName)+entry->FileNameLength;
    check(entry->FileNameLength%sizeof(wchar_t)==0&&recordEnd<=lease.entryBytes);std::wstring name(entry->FileName,entry->FileNameLength/sizeof(wchar_t));
    if(entry->NextEntryOffset){check(entry->NextEntryOffset>=offsetof(FILE_ID_BOTH_DIR_INFO,FileName)&&lease.entryOffset+entry->NextEntryOffset<lease.entryBytes);lease.entryOffset+=entry->NextEntryOffset;}else lease.entryOffset=lease.entryBytes;
    if(name==L"."||name==L"..")continue;
    check(!name.empty()&&name.find(L'\\')==std::wstring::npos&&name.find(L'/')==std::wstring::npos&&name.find(L'\0')==std::wstring::npos,"INVALID_PATH");napi_value result;check(napi_create_string_utf16(env,reinterpret_cast<const char16_t*>(name.data()),name.size(),&result)==napi_ok);return result;
  }
});}
napi_value wrapLease(napi_env env,Lease* lease,napi_value callback){
  napi_valuetype type;check(napi_typeof(env,callback,&type)==napi_ok&&type==napi_function);check(napi_create_reference(env,callback,1,&lease->metadata)==napi_ok);napi_value result;check(napi_create_object(env,&result)==napi_ok);
  const napi_property_descriptor methods[]={
    {"metadata",nullptr,leaseMetadata,nullptr,nullptr,nullptr,napi_default,nullptr},{"read",nullptr,leaseRead,nullptr,nullptr,nullptr,napi_default,nullptr},{"write",nullptr,leaseWrite,nullptr,nullptr,nullptr,napi_default,nullptr},{"flush",nullptr,leaseFlush,nullptr,nullptr,nullptr,napi_default,nullptr},{"next",nullptr,leaseNext,nullptr,nullptr,nullptr,napi_default,nullptr},{"close",nullptr,leaseClose,nullptr,nullptr,nullptr,napi_default,nullptr}};
  check(napi_define_properties(env,result,sizeof(methods)/sizeof(methods[0]),methods)==napi_ok);check(napi_type_tag_object(env,result,&leaseTypeTag)==napi_ok);check(napi_wrap(env,result,lease,[](napi_env,void* data,void*){delete static_cast<Lease*>(data);},nullptr,nullptr)==napi_ok);return result;
}
napi_value openManagedFile(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,3);auto opt=options(env,values[0],values[1]);check(!opt.directory&&opt.maxBytes<=8ULL*1024*1024*1024,"SIZE_LIMIT");const auto mode=text(env,property(env,values[1],"mode"));check(mode==L"read"||mode==L"create"||mode==L"flush");std::unique_ptr<Lease> lease(new Lease(env,opt));lease->reading=mode==L"read";lease->writing=mode==L"create";lease->writable=!lease->reading;
  if(mode==L"create"){
    lease->tree=walk(opt.path,lease->user,&opt.root,false,false,true,0,opt.maxBytes);check(lease->tree.missing,"ALREADY_EXISTS");check(lease->tree.handles.size()==opt.path.components.size(),"MISSING");Security security(lease->user);Handle file(CreateFileW(opt.path.value.c_str(),GENERIC_READ|GENERIC_WRITE|READ_CONTROL,FILE_SHARE_READ,&security.attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_WRITE_THROUGH,nullptr));if(file.value==INVALID_HANDLE_VALUE){if(GetLastError()==ERROR_FILE_EXISTS||GetLastError()==ERROR_ALREADY_EXISTS)reject("ALREADY_EXISTS");reject("IO_ERROR");}lease->tree.handles.push_back(std::move(file));lease->tree.missing=false;
  }else lease->tree=walk(opt.path,lease->user,&opt.root,false,false,false,GENERIC_READ|(lease->writable?GENERIC_WRITE:0),opt.maxBytes);
  validateLease(*lease);expected(env,lease->tree.leaf(),values[1]);auto result=wrapLease(env,lease.get(),values[2]);lease.release();return result;
});}
napi_value openManagedDirectory(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,3);auto opt=options(env,values[0],values[1]);check(opt.directory);std::unique_ptr<Lease> lease(new Lease(env,opt));lease->directory=true;lease->tree=walk(opt.path,lease->user,&opt.root,true,false,false,FILE_LIST_DIRECTORY,opt.maxBytes);auto result=wrapLease(env,lease.get(),values[2]);lease.release();return result;});}
napi_value createManagedDirectory(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,3);auto opt=options(env,values[0],values[1]);check(opt.directory&&opt.path.components.size()>0);User user;auto parentPath=canonical(joinPrefix(opt.path,opt.path.components.size()-1));auto parent=walk(parentPath,user,opt.root.value==opt.path.value?nullptr:&opt.root,true,false,false,0,0);Security security(user);if(!CreateDirectoryW(opt.path.value.c_str(),&security.attributes)){if(GetLastError()==ERROR_ALREADY_EXISTS)reject("ALREADY_EXISTS");reject("IO_ERROR");}
  Lease lease(env,opt);lease.directory=true;lease.tree=walk(opt.path,lease.user,&opt.root,true,false,false,0,0);check(napi_create_reference(env,values[2],1,&lease.metadata)==napi_ok);return metadata(lease);
});}
napi_value syncManagedDirectory(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,2);auto opt=options(env,values[0],values[1]);check(opt.directory);const bool privateRoot=boolean(env,values[1],"private",true);User user;
  // A destination's parent can be a safe ordinary directory. This explicit
  // flush-only mode retains the root identity/path/handle checks, but applies
  // the existing trusted-ancestor ACL policy rather than private-root ACLs.
  auto tree=walk(opt.path,user,&opt.root,true,false,false,GENERIC_READ|GENERIC_WRITE,0,privateRoot);check(FlushFileBuffers(tree.leaf()));validate(tree.leaf(),opt.path.value,user,true,privateRoot,privateRoot&&opt.path.value==opt.root.value,0);return undefined(env);
});}
napi_value renameManaged(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,4);auto opt=options(env,values[0],values[2]);auto destination=canonical(text(env,values[1]));check(!opt.directory);Lease source(env,opt);source.tree=walk(opt.path,source.user,&opt.root,false,false,false,DELETE,opt.maxBytes);expected(env,source.tree.leaf(),values[2]);auto target=walk(destination,source.user,&opt.root,false,false,true,0,opt.maxBytes);check(target.missing,"ALREADY_EXISTS");check(target.handles.size()==destination.components.size(),"MISSING");
  std::vector<BYTE> bytes(sizeof(FILE_RENAME_INFO)+destination.value.size()*sizeof(wchar_t));auto rename=reinterpret_cast<FILE_RENAME_INFO*>(bytes.data());rename->ReplaceIfExists=FALSE;rename->RootDirectory=nullptr;rename->FileNameLength=static_cast<DWORD>(destination.value.size()*sizeof(wchar_t));memcpy(rename->FileName,destination.value.data(),rename->FileNameLength);if(!SetFileInformationByHandle(source.tree.leaf(),FileRenameInfo,rename,static_cast<DWORD>(bytes.size()))){if(GetLastError()==ERROR_ALREADY_EXISTS||GetLastError()==ERROR_FILE_EXISTS)reject("ALREADY_EXISTS");reject("IO_ERROR");}
  Handle leaf=std::move(source.tree.handles.back());target.handles.push_back(std::move(leaf));source.tree=std::move(target);source.opt.path=destination;check(napi_create_reference(env,values[3],1,&source.metadata)==napi_ok);return metadata(source);
});}
napi_value removeManaged(napi_env env,napi_callback_info info){return guarded(env,[&]{auto values=args(env,info,2);auto opt=options(env,values[0],values[1]);User user;auto tree=walk(opt.path,user,&opt.root,opt.directory,false,false,DELETE,opt.maxBytes);expected(env,tree.leaf(),values[1]);FILE_DISPOSITION_INFO disposition{TRUE};check(SetFileInformationByHandle(tree.leaf(),FileDispositionInfo,&disposition,sizeof(disposition)));return undefined(env);});}
